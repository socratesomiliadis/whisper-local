import pdfMake from "pdfmake/build/pdfmake.js";
import pdfFonts from "pdfmake/build/vfs_fonts.js";

// Fonts are bundled with the app so exports also work offline.
pdfMake.addVirtualFileSystem(pdfFonts);

const timestamp = (seconds) => {
  const milliseconds = Math.max(0, Math.round((Number(seconds) || 0) * 1000));
  const pad = (number, width = 2) => String(number).padStart(width, "0");
  return `${pad(Math.floor(milliseconds / 3600000))}:${pad(Math.floor(milliseconds / 60000) % 60)}:${pad(Math.floor(milliseconds / 1000) % 60)}.${pad(milliseconds % 1000, 3)}`;
};

// Soft break opportunities stop long URLs or words from widening the table.
const wrappableText = (text, limit = 24) =>
  text.replace(/\S+/gu, (word) => {
    const characters = Array.from(word);
    const parts = [];
    for (let index = 0; index < characters.length; index += limit)
      parts.push(characters.slice(index, index + limit).join(""));
    return parts.join("\u200b");
  });

// Keep ordinary segments together. Very long edits become small continuation
// rows so even a segment spanning several pages cannot overflow a page.
const transcriptChunks = (text) => {
  const characters = Array.from(text.trim());
  const chunks = [];
  for (let start = 0; start < characters.length; ) {
    let end = Math.min(start + 600, characters.length);
    let newlines = 0;
    for (let index = start; index < end; index++) {
      if (characters[index] === "\n" && ++newlines > 10) {
        end = index;
        break;
      }
    }
    if (end < characters.length) {
      for (let index = end; index > start; index--) {
        if (/\s/u.test(characters[index])) {
          end = index;
          break;
        }
      }
    }
    const chunk = characters.slice(start, end).join("").trim();
    if (chunk) chunks.push(chunk);
    start = end;
    while (start < characters.length && /\s/u.test(characters[start])) start++;
  }
  return chunks.length ? chunks : [""];
};

export async function createTranscriptPdf(data, title = "Transcript") {
  const speakers = data.speakers || {};
  const segments = data.segments || [];
  const hasSpeakers =
    Object.keys(speakers).length > 0 ||
    segments.some((segment) => segment.speaker);
  const metadata = [
    data.language ? `Language: ${data.language.toUpperCase()}` : null,
    `${segments.length} transcript ${segments.length === 1 ? "segment" : "segments"}`,
    "Timestamps refer to the original recording",
  ].filter(Boolean);
  const rows = segments.flatMap((segment) =>
    transcriptChunks(String(segment.text || "")).map((text) => [
      {
        stack: [
          { text: timestamp(segment.start) },
          { text: `- ${timestamp(segment.end)}` },
        ],
        style: "timing",
      },
      ...(hasSpeakers
        ? [
            {
              text: wrappableText(
                speakers[segment.speaker] || segment.speaker || "Unassigned",
                8,
              ),
              bold: true,
              fontSize: 9,
            },
          ]
        : []),
      { text: wrappableText(text), lineHeight: 1.35 },
    ]),
  );

  const definition = {
    info: { title, creator: "Whisper Local", subject: "Audio transcript" },
    pageSize: "A4",
    pageMargins: [40, 52, 40, 48],
    defaultStyle: { font: "Roboto", fontSize: 10, color: "#18212f" },
    header: {
      text: "WHISPER LOCAL / TRANSCRIPT",
      color: "#64748b",
      fontSize: 8,
      characterSpacing: 1,
      margin: [40, 24, 40, 0],
    },
    footer: (page, count) => ({
      columns: [
        { text: "Whisper Local" },
        { text: `Page ${page} of ${count}`, alignment: "right" },
      ],
      color: "#64748b",
      fontSize: 8,
      margin: [40, 18, 40, 0],
    }),
    styles: {
      timing: { color: "#475569", fontSize: 8, lineHeight: 1.4 },
      columnHeading: { bold: true, fontSize: 8, color: "#475569" },
    },
    content: [
      {
        text: wrappableText(title, 20),
        bold: true,
        fontSize: 22,
        margin: [0, 0, 0, 10],
      },
      {
        text: metadata.join("  |  "),
        color: "#64748b",
        fontSize: 8,
        lineHeight: 1.3,
        margin: [0, 0, 0, 22],
      },
      ...(rows.length
        ? [
            {
              table: {
                headerRows: 1,
                keepWithHeaderRows: 1,
                dontBreakRows: true,
                widths: hasSpeakers ? [68, 72, "*"] : [68, "*"],
                body: [
                  [
                    "START / END",
                    ...(hasSpeakers ? ["SPEAKER"] : []),
                    "TRANSCRIPT",
                  ].map((text) => ({ text, style: "columnHeading" })),
                  ...rows,
                ],
              },
              layout: {
                hLineWidth: (index) => (index === 0 ? 0 : 0.5),
                vLineWidth: () => 0,
                hLineColor: () => "#e2e8f0",
                fillColor: (row) => (row === 0 ? "#f1f5f9" : null),
                paddingLeft: () => 8,
                paddingRight: () => 8,
                paddingTop: () => 10,
                paddingBottom: () => 10,
              },
            },
          ]
        : [
            {
              text: wrappableText(data.text?.trim() || "No speech detected."),
              lineHeight: 1.35,
            },
          ]),
    ],
  };

  return pdfMake.createPdf(definition).getBlob();
}
