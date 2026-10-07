# Security

Whisper Local is a single-user desktop companion. The server binds to
`127.0.0.1`, validates the Host header, and requires a per-launch token for API
requests. Keep it on loopback; exposing it through a reverse proxy or public
interface is outside the supported design.

Audio is processed locally. Temporary uploads are removed when processing ends;
a forced process termination can leave files in the operating system's temp
directory. Results are held in memory. Downloaded model files are executable
inputs to third-party ML libraries: use the model repositories configured in
the application and keep dependencies updated.

Do not include recordings, transcripts, access tokens, or model caches in issues
or pull requests. Hugging Face tokens are used for model downloads and are not
saved by the application. Known token patterns are redacted from speaker setup
errors.

After publishing this repository, enable GitHub's private vulnerability reporting
in repository settings and use that channel for sensitive reports. Avoid public
issues containing credentials or private audio.
