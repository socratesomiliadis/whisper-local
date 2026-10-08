# Contributing

Use Python 3.11 or 3.12. In a virtual environment, install the CPU engine first
and then the editable development package:

```sh
python -m pip install -r requirements-engine.txt --index-url https://download.pytorch.org/whl/cpu
python -m pip install -e ".[dev]"
python -m ruff check .
python -m ruff format --check .
python -m pytest
python -m build
```

On Windows with the private runtime already installed, replace `python` with
`.\.runtime\python.exe`. Do not change your system Python or install CUDA just
to run the unit tests.

For a lightweight test environment without ML libraries:

```sh
python -m pip install -e . --no-deps
python -m pip install "Flask>=3.1,<4" "waitress>=3,<4" "platformdirs>=4,<5" "pytest>=8,<9" "ruff>=0.11,<1" "build>=1.2,<2"
python -m pytest
```

Unit tests replace model inference with deterministic fixtures. Worker lifecycle
tests spawn real small Python processes to verify completion, unexpected exit,
cancellation, and shutdown cleanup. They do not open ports, download weights,
require a GPU, or read a Hugging Face token.

Browser checks use Playwright with request interception, so no dev server is
needed. Install Node.js 22 or later, then run:

```sh
npm ci
npm run build
npx playwright install chromium
npm test
npm run format:check
```

The browser runner invokes Python through `PYTHON`, or `python` by default. On
Windows you can set `$env:PYTHON = "$PWD/.runtime/python.exe"`. An existing Chrome
installation can be used with `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`. To refresh
the documented fixture screenshot, set `UPDATE_SCREENSHOT=1` for a browser run.
Checks cover edited exports, undo/redo, search and speaker assignment, library
retention/deletion, preferences, queues/cancellation, media controls, and responsive
layouts with deterministic API responses. Mocked browser recording and speaker
fixtures do not establish real microphone or Community-1 inference quality.

The frontend source lives in `frontend/`. React owns the layout and application
state; the transcript editor and media engine keep their isolated DOM elements.
Tailwind provides styling and shadcn/ui components use Base UI. Install additional
components with `npx shadcn add <component>`.

`npm run build` writes the bundled `app.js` and `style.css` to
`src/whisper_local/static/`. Commit both built assets with frontend changes so
the Python app works without Node.js installed. Before starting a Vite dev server,
check for an existing instance. `npm run dev` proxies API requests to the local
app on port 8765 and obtains its session token from the proxied home page.

Real inference is opt-in and needs a valid speech recording and an already
downloaded Base model and English alignment resources:

```sh
# Set WHISPER_TEST_AUDIO to your local WAV/MP3 path, then:
python -m pytest -m integration
```

For API smoke checks, use Flask's test client in a Python script guarded by
`if __name__ == "__main__":` so spawned workers import safely on Windows. Check
that the requested model's `.ready` and `model.bin` files already exist when the
test must run without downloads. The current worker creates a process per job;
cached files persist, but model objects reload in memory. Generated WAV fixtures
can exercise decode, ranges, stage updates, normal completion, and cancellation
without retaining real recordings. Native speaker inference still requires its
separate gated download and must be verified explicitly.

Before starting a development server, check whether one already runs on the
chosen port. Most regression work needs no server: browser requests are
intercepted, and Python tests use the Flask test client. Keep the frontend's
editor, media workspace, and local library modules separate. Transcript segments
are the source for plain text, clipboard output, saved corrections, and exports;
avoid keeping competing edited text copies. Treat the batch queue as tab-local:
refresh restores the active job, not its pending files.

Add a focused regression test for behavior changes. Run the checks above before
opening a pull request; explain the user-visible change and any inference or
platform limitations. Keep recordings, transcripts, runtimes, downloaded models,
and credentials out of commits. Use SVG icons for UI additions.
