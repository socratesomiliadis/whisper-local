"use strict";

// The editor is independent of audio loading and persistence. Its snapshots are
// the single source for plain text, saved history, and every export format.
(() => {
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const el = (id) => document.getElementById(id);
  const escapePattern = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const timestamp = (seconds, separator = ",") => {
    const ms = Math.max(0, Math.round(Number(seconds) * 1000));
    const pad = (n, size = 2) => String(n).padStart(size, "0");
    return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)}${separator}${pad(ms % 1000, 3)}`;
  };
  const shortTime = (seconds) => {
    const whole = Math.floor(seconds);
    return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
  };
  const wrap = (text, limit) => {
    const words = text
      .trim()
      .split(/\s+/u)
      .filter(Boolean)
      .flatMap((word) => {
        const chars = Array.from(word);
        const parts = [];
        for (let i = 0; i < chars.length; i += limit)
          parts.push(chars.slice(i, i + limit).join(""));
        return parts;
      });
    const lines = [];
    let line = "";
    for (const word of words) {
      if (line && Array.from(`${line} ${word}`).length > limit) {
        lines.push(line);
        line = word;
      } else line += `${line ? " " : ""}${word}`;
    }
    if (line) lines.push(line);
    return lines;
  };

  class TranscriptEditor {
    static text(data) {
      const context = Object.create(TranscriptEditor.prototype);
      context.data = {
        ...data,
        speakers: data.speakers || {},
        segments: data.segments || [],
      };
      return context.text();
    }

    static export(data, format, options = {}) {
      const context = Object.create(TranscriptEditor.prototype);
      context.data = clone({
        ...data,
        speakers: data.speakers || {},
        segments: data.segments || [],
      });
      context.exportOptions = {
        lineLength: 42,
        maxDuration: 6,
        includeSpeakers: true,
        ...options,
      };
      return context.export(format);
    }

    constructor({
      onChange = () => {},
      onSeek = () => {},
      onStatus = () => {},
    } = {}) {
      this.onChange = onChange;
      this.onSeek = onSeek;
      this.onStatus = onStatus;
      this.data = null;
      this.past = [];
      this.future = [];
      this.pending = null;
      this.timer = null;
      this.audioAvailable = false;
      this.playbackTime = 0;
      this.activeIndex = -1;
      this.matches = [];
      this.matchIndex = -1;
      this.rows = [];
      const listen = (id, event, callback) =>
        el(id)?.addEventListener(event, callback);
      listen("plain-view", "click", () => this.view(false));
      listen("timed-view", "click", () => this.view(true));
      listen("undo-edit", "click", () => this.undo());
      listen("redo-edit", "click", () => this.redo());
      listen("add-speaker", "click", () => this.addSpeaker());
      listen("search-text", "input", () => this.updateSearch(true));
      listen("search-next", "click", () => this.moveSearch(1));
      listen("search-prev", "click", () => this.moveSearch(-1));
      listen("search-text", "keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          this.moveSearch(event.shiftKey ? -1 : 1);
        }
      });
      listen("replace-all", "click", () => this.replaceAll());
      listen("follow-playback", "change", () => {
        if (el("follow-playback").checked) this.scrollActive();
      });
      listen("results", "keydown", (event) => {
        if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
        if (
          event.target.matches(
            "#search-text, #replace-text, #subtitle-line-length, #subtitle-duration",
          )
        )
          return;
        const key = event.key.toLowerCase();
        if (key === "z" || key === "y") {
          event.preventDefault();
          if (key === "y" || event.shiftKey) this.redo();
          else this.undo();
        }
      });
      this.updateUndo();
    }

    load(data) {
      clearTimeout(this.timer);
      this.pending = null;
      this.past = [];
      this.future = [];
      this.data = clone(data || {});
      this.data.speakers = { ...(this.data.speakers || {}) };
      this.data.segments = (this.data.segments || []).map((segment) => {
        const start = Math.max(0, Number(segment.start) || 0);
        const end = Math.max(start + 0.001, Number(segment.end) || 0);
        const speaker = segment.speaker || null;
        if (speaker && !Object.hasOwn(this.data.speakers, speaker))
          this.data.speakers[speaker] =
            speaker === "unknown" ? "Unassigned" : speaker;
        return {
          ...segment,
          start,
          end,
          text: String(segment.text || ""),
          speaker,
        };
      });
      // Legacy results with only text still become editable and exportable.
      if (!this.data.segments.length && String(this.data.text || "").trim()) {
        this.data.segments.push({
          start: 0,
          end: Math.max(0.001, Number(this.data.duration) || 1),
          text: String(this.data.text),
          speaker: null,
        });
      }
      this.activeIndex = -1;
      this.matchIndex = -1;
      this.render();
      this.view(true);
    }

    snapshot() {
      if (!this.data) return null;
      const snapshot = clone(this.data);
      snapshot.text = this.text();
      snapshot.srt = this.export("srt");
      return snapshot;
    }

    text() {
      if (!this.data) return "";
      const speakers = Object.keys(this.data.speakers).length > 0;
      return this.data.segments
        .map((segment) => {
          const prefix = speakers
            ? `${this.data.speakers[segment.speaker] || "Unassigned"}: `
            : "";
          return prefix + segment.text.trim();
        })
        .join(speakers ? "\n\n" : " ")
        .trim();
    }

    export(format) {
      if (!this.data) return "";
      if (format === "txt") return `${this.text()}\n`;
      if (format === "json")
        return JSON.stringify(this.snapshot(), null, 2) + "\n";
      if (format !== "srt" && format !== "vtt")
        throw new Error(`Unsupported export format: ${format}`);
      const lineLimit = Math.max(
        10,
        Math.min(
          100,
          Number(
            this.exportOptions?.lineLength ?? el("subtitle-line-length")?.value,
          ) || 42,
        ),
      );
      const durationLimit = Math.max(
        1,
        Math.min(
          30,
          Number(
            this.exportOptions?.maxDuration ?? el("subtitle-duration")?.value,
          ) || 6,
        ),
      );
      const includeSpeakers =
        this.exportOptions?.includeSpeakers ??
        el("subtitle-speakers")?.checked ??
        true;
      const cues = [];
      for (const segment of this.data.segments) {
        const prefix =
          includeSpeakers && Object.keys(this.data.speakers).length
            ? `${this.data.speakers[segment.speaker] || "Unassigned"}: `
            : "";
        const lines = wrap(prefix + segment.text, lineLimit);
        const blocks = [];
        for (let i = 0; i < lines.length; i += 2)
          blocks.push(lines.slice(i, i + 2).join("\n"));
        const duration = segment.end - segment.start;
        for (let blockIndex = 0; blockIndex < blocks.length; blockIndex++) {
          const start = segment.start + (duration * blockIndex) / blocks.length;
          const end =
            segment.start + (duration * (blockIndex + 1)) / blocks.length;
          const words = blocks[blockIndex].split(/\s+/u);
          const count = Math.min(
            words.length,
            Math.max(1, Math.ceil((end - start) / durationLimit)),
          );
          for (let i = 0; i < count; i++) {
            const part = words
              .slice(
                Math.floor((i * words.length) / count),
                Math.floor(((i + 1) * words.length) / count),
              )
              .join(" ");
            const cueStart = start + ((end - start) * i) / count;
            const cueEnd = Math.min(
              end,
              cueStart + Math.min(durationLimit, (end - start) / count),
            );
            cues.push({
              start: cueStart,
              end: cueEnd,
              text: wrap(part, lineLimit).join("\n"),
            });
          }
        }
      }
      const separator = format === "vtt" ? "." : ",";
      const output = cues
        .map(
          (cue, index) =>
            `${index + 1}\n${timestamp(cue.start, separator)} --> ${timestamp(cue.end, separator)}\n${cue.text}`,
        )
        .join("\n\n");
      return (
        (format === "vtt" ? "WEBVTT\n\n" : "") + output + (output ? "\n" : "")
      );
    }

    beginEdit() {
      if (!this.pending) this.pending = clone(this.data);
      this.future = [];
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.flushEdit(), 350);
      this.updateUndo();
    }

    flushEdit() {
      clearTimeout(this.timer);
      if (!this.pending) return;
      if (JSON.stringify(this.pending) !== JSON.stringify(this.data)) {
        this.past.push(this.pending);
        if (this.past.length > 100) this.past.shift();
        this.onChange(this.snapshot());
      }
      this.pending = null;
      this.updateUndo();
    }

    change(callback) {
      if (!this.data) return;
      this.flushEdit();
      const previous = clone(this.data);
      callback();
      if (JSON.stringify(previous) === JSON.stringify(this.data)) return;
      this.past.push(previous);
      if (this.past.length > 100) this.past.shift();
      this.future = [];
      this.render();
      this.onChange(this.snapshot());
    }

    undo() {
      this.flushEdit();
      if (!this.past.length) return;
      this.future.push(clone(this.data));
      this.data = this.past.pop();
      this.render();
      this.onChange(this.snapshot());
    }

    redo() {
      this.flushEdit();
      if (!this.future.length) return;
      this.past.push(clone(this.data));
      this.data = this.future.pop();
      this.render();
      this.onChange(this.snapshot());
    }

    updateUndo() {
      if (el("undo-edit"))
        el("undo-edit").disabled = !this.pending && !this.past.length;
      if (el("redo-edit")) el("redo-edit").disabled = !this.future.length;
    }

    view(timed) {
      el("transcript").hidden = timed;
      el("segments").hidden = !timed;
      for (const [id, selected] of [
        ["plain-view", !timed],
        ["timed-view", timed],
      ]) {
        el(id).classList.toggle("selected", selected);
        el(id).setAttribute("aria-pressed", String(selected));
      }
    }

    updateDerived() {
      if (!this.data) return;
      this.data.text = this.text();
      el("transcript").value = this.data.text;
      const words = this.data.segments
        .map((segment) => segment.text)
        .join(" ")
        .trim()
        .split(/\s+/u)
        .filter(Boolean).length;
      const count = Object.keys(this.data.speakers).filter(
        (id) => id !== "unknown",
      ).length;
      el("result-meta").textContent =
        `${String(this.data.language || "auto").toUpperCase()} · ${words.toLocaleString()} words${count ? ` · ${count} speaker${count === 1 ? "" : "s"}` : ""}${this.data.device ? ` · ${this.data.device === "cuda" ? "GPU" : "CPU"}` : ""}${typeof this.data.elapsed === "number" ? ` · ${this.data.elapsed}s` : ""}`;
      this.updateSearch(false);
    }

    render() {
      const focused = document.activeElement;
      const focusKey = focused?.dataset?.editorFocus;
      const selection =
        typeof focused?.selectionStart === "number"
          ? [focused.selectionStart, focused.selectionEnd]
          : null;
      this.renderSpeakers();
      this.rows = [];
      el("segments").replaceChildren();
      for (const [index, segment] of this.data.segments.entries()) {
        const row = document.createElement("div");
        row.className = "segment";
        row.dataset.index = String(index);
        const time = document.createElement("button");
        time.type = "button";
        time.className = "segment-time-button";
        time.textContent = shortTime(segment.start);
        time.setAttribute(
          "aria-label",
          `Play audio at ${shortTime(segment.start)}`,
        );
        time.disabled = !this.audioAvailable;
        time.addEventListener("click", () => this.onSeek(segment.start));
        const body = document.createElement("div");
        body.className = "segment-body";
        const speakerLabel = document.createElement("strong");
        speakerLabel.className = "speaker-label";
        speakerLabel.textContent =
          this.data.speakers[segment.speaker] || "Unassigned";
        speakerLabel.hidden = !segment.speaker;
        const text = document.createElement("textarea");
        text.className = "segment-text";
        text.dataset.editorFocus = `text-${index}`;
        text.rows = Math.min(
          6,
          Math.max(2, Math.ceil(segment.text.length / 65)),
        );
        text.value = segment.text;
        text.setAttribute("aria-label", `Edit segment ${index + 1}`);
        text.addEventListener("input", () => {
          this.beginEdit();
          segment.text = text.value;
          delete segment.words;
          this.updateDerived();
        });
        text.addEventListener("blur", () => this.flushEdit());
        const controls = document.createElement("div");
        controls.className = "segment-controls";
        for (const [key, title] of [
          ["start", "Start"],
          ["end", "End"],
        ]) {
          const label = document.createElement("label");
          label.textContent = `${title} (s)`;
          const input = document.createElement("input");
          input.type = "number";
          input.className = "segment-time";
          input.dataset.editorFocus = `${key}-${index}`;
          input.min = "0";
          input.step = "0.001";
          input.value = String(segment[key]);
          input.setAttribute(
            "aria-label",
            `${title} time for segment ${index + 1}`,
          );
          input.addEventListener("change", () => {
            const value = Number(input.value);
            const valid =
              input.value !== "" &&
              Number.isFinite(value) &&
              value >= 0 &&
              (key === "start" ? value < segment.end : value > segment.start);
            if (!valid) {
              input.value = String(segment[key]);
              this.onStatus(
                "Start time must be nonnegative and earlier than end time.",
                "error",
              );
              return;
            }
            this.change(() => {
              segment[key] = value;
              delete segment.words;
            });
          });
          label.append(input);
          controls.append(label);
        }
        const label = document.createElement("label");
        label.textContent = "Speaker";
        const select = document.createElement("select");
        select.className = "segment-speaker";
        select.dataset.editorFocus = `speaker-${index}`;
        select.setAttribute("aria-label", `Speaker for segment ${index + 1}`);
        this.fillSpeakerSelect(select, segment.speaker);
        select.addEventListener("change", () =>
          this.change(() => {
            segment.speaker = select.value || null;
          }),
        );
        label.append(select);
        controls.append(label);
        body.append(speakerLabel, text, controls);
        row.append(time, body);
        this.rows.push({ row, text, time, speakerLabel, select });
        el("segments").append(row);
      }
      this.updateDerived();
      this.updateUndo();
      this.setPlaybackTime(this.playbackTime);
      if (focusKey) {
        const next = Array.from(
          el("results").querySelectorAll("[data-editor-focus]"),
        ).find((node) => node.dataset.editorFocus === focusKey);
        if (next) {
          next.focus({ preventScroll: true });
          if (selection) next.setSelectionRange(...selection);
        }
      }
    }

    fillSpeakerSelect(select, selected) {
      select.replaceChildren();
      const add = (id, name) => {
        const option = document.createElement("option");
        option.value = id;
        option.textContent = name;
        select.append(option);
      };
      add("", "Unassigned");
      for (const [id, name] of Object.entries(this.data.speakers))
        add(id, name);
      select.value = selected || "";
    }

    renderSpeakers() {
      el("speaker-names").hidden = false;
      el("speaker-name-fields").replaceChildren();
      for (const [id, name] of Object.entries(this.data.speakers)) {
        const label = document.createElement("label");
        label.className = "speaker-name";
        const caption = document.createElement("span");
        caption.textContent = name;
        const input = document.createElement("input");
        input.value = name;
        input.maxLength = 60;
        input.dataset.editorFocus = `name-${id}`;
        input.setAttribute("aria-label", `Rename ${name}`);
        input.addEventListener("input", () => {
          this.beginEdit();
          this.data.speakers[id] = input.value.trim() || name;
          for (let index = 0; index < this.rows.length; index++) {
            const row = this.rows[index];
            const segment = this.data.segments[index];
            this.fillSpeakerSelect(row.select, segment.speaker);
            row.speakerLabel.textContent =
              this.data.speakers[segment.speaker] || "Unassigned";
          }
          this.updateDerived();
        });
        input.addEventListener("blur", () => this.flushEdit());
        label.append(caption, input);
        el("speaker-name-fields").append(label);
      }
    }

    addSpeaker() {
      if (!this.data) return;
      let number = 1;
      while (Object.hasOwn(this.data.speakers, `manual_${number}`)) number++;
      this.change(() => {
        this.data.speakers[`manual_${number}`] =
          `Speaker ${Object.keys(this.data.speakers).filter((id) => id !== "unknown").length + 1}`;
      });
      el("speaker-name-fields")
        .lastElementChild?.querySelector("input")
        ?.focus();
    }

    updateSearch(reset) {
      const query = el("search-text")?.value || "";
      const previous = this.matches[this.matchIndex];
      this.matches = [];
      if (query && this.data) {
        const expression = new RegExp(escapePattern(query), "giu");
        this.data.segments.forEach((segment, index) => {
          for (const match of segment.text.matchAll(expression))
            this.matches.push({
              index,
              start: match.index,
              end: match.index + match[0].length,
            });
        });
      }
      this.matchIndex = reset
        ? -1
        : previous
          ? this.matches.findIndex(
              (match) =>
                match.index === previous.index &&
                match.start === previous.start,
            )
          : -1;
      this.markSearch();
    }

    markSearch() {
      const selected = this.matches[this.matchIndex];
      const indices = new Set(this.matches.map((match) => match.index));
      this.rows.forEach(({ row }, index) => {
        row.classList.toggle("search-match", indices.has(index));
        row.classList.toggle("search-current", selected?.index === index);
      });
      if (el("search-count"))
        el("search-count").textContent = this.matches.length
          ? `${this.matchIndex >= 0 ? this.matchIndex + 1 : "0"} of ${this.matches.length}`
          : "No matches";
      for (const id of ["search-prev", "search-next", "replace-all"])
        if (el(id)) el(id).disabled = !this.matches.length;
    }

    moveSearch(direction) {
      if (!this.matches.length) return;
      this.matchIndex =
        this.matchIndex < 0
          ? direction < 0
            ? this.matches.length - 1
            : 0
          : (this.matchIndex + direction + this.matches.length) %
            this.matches.length;
      const match = this.matches[this.matchIndex];
      const row = this.rows[match.index];
      this.view(true);
      this.markSearch();
      row.text.focus({ preventScroll: true });
      row.text.setSelectionRange(match.start, match.end);
      row.row.scrollIntoView({ block: "nearest", behavior: "auto" });
      if (this.audioAvailable)
        this.onSeek(this.data.segments[match.index].start);
    }

    replaceAll() {
      const query = el("search-text")?.value || "";
      if (!query || !this.matches.length) return;
      const count = this.matches.length;
      const replacement = el("replace-text")?.value || "";
      const expression = new RegExp(escapePattern(query), "giu");
      this.change(() =>
        this.data.segments.forEach((segment) => {
          const updated = segment.text.replace(expression, () => replacement);
          if (updated !== segment.text) delete segment.words;
          segment.text = updated;
        }),
      );
      this.onStatus(
        `Replaced ${count} match${count === 1 ? "" : "es"}.`,
        "success",
      );
    }

    setAudioAvailable(available) {
      this.audioAvailable = Boolean(available);
      this.rows.forEach(({ time }) => {
        time.disabled = !this.audioAvailable;
      });
      if (!this.audioAvailable)
        this.rows.forEach(({ row }) => row.classList.remove("active"));
      else this.setPlaybackTime(this.playbackTime);
    }

    setPlaybackTime(seconds) {
      this.playbackTime = Number(seconds) || 0;
      if (!this.data) return;
      const index = this.audioAvailable
        ? this.data.segments.findIndex(
            (segment) =>
              this.playbackTime >= segment.start &&
              this.playbackTime < segment.end,
          )
        : -1;
      this.rows.forEach(({ row }, rowIndex) => {
        row.classList.toggle("active", rowIndex === index);
        if (rowIndex === index) row.setAttribute("aria-current", "true");
        else row.removeAttribute("aria-current");
      });
      if (index !== this.activeIndex) {
        this.activeIndex = index;
        if (el("follow-playback")?.checked) this.scrollActive();
      }
    }

    scrollActive() {
      // Following audio must not move the page while somebody is editing.
      if (
        el("segments").hidden ||
        el("segments").contains(document.activeElement)
      )
        return;
      this.rows[this.activeIndex]?.row.scrollIntoView({
        block: "nearest",
        behavior: "auto",
      });
    }
  }

  window.TranscriptEditor = TranscriptEditor;
})();
