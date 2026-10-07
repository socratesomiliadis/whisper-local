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

Unit tests replace model workers with deterministic fixtures. They do not open
ports, download weights, require a GPU, or read a Hugging Face token.

Browser checks use Playwright with request interception, so no dev server is
needed. Install Node.js 22 or later, then run:

```sh
npm ci
npx playwright install chromium
npm test
npm run format:check
```

The browser runner invokes Python through `PYTHON`, or `python` by default. On
Windows you can set `$env:PYTHON = "$PWD/.runtime/python.exe"`. An existing Chrome
installation can be used with `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`. To refresh
the documented fixture screenshot, set `UPDATE_SCREENSHOT=1` for a browser run.

Real inference is opt-in and needs a valid speech recording and an already
downloaded Base model:

```sh
# Set WHISPER_TEST_AUDIO to your local WAV/MP3 path, then:
python -m pytest -m integration
```

Add a focused regression test for behavior changes. Run the checks above before
opening a pull request; explain the user-visible change and any inference or
platform limitations. Keep recordings, transcripts, runtimes, downloaded models,
and credentials out of commits. Use SVG icons for UI additions.
