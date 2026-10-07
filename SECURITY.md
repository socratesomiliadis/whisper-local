# Security

Whisper Local is a single-user desktop companion. The server binds to
`127.0.0.1`, validates the Host header, and requires a per-launch token for API
requests. Keep it on loopback; exposing it through a reverse proxy or public
interface is outside the supported design.

Audio and microphone recordings are processed locally. Each transcription uses
an isolated worker process. Cancellation stops that process, and temporary uploads
are removed after success, failure, cancellation, or normal app shutdown. An
operating-system kill or crash can leave files in the system temp directory.

Recent server results are held in memory and disappear when the app closes.
The browser's **Save transcripts** option is enabled by default: transcripts and
corrections persist in IndexedDB for that browser profile and app origin. Disable
it to stop future autosaves; existing records remain until you delete them.
**Keep audio for playback** is disabled by default and stores audio only when
enabled. Delete a local-library entry to remove its transcript and retained audio,
or use **Delete all**. Exported downloads remain wherever you saved them.

The local library is ordinary browser storage, not an encrypted vault. Anyone
with access to that browser profile may be able to read saved material. Site-data
clearing removes the library; browser quotas or private browsing may prevent
retention. Transcription, playback, subtitle, and retention preferences are stored
in local storage. Active-job recovery uses session storage; pending batch files
are kept only in the open tab. Download tokens are not stored in these records.

Downloaded model files are executable inputs to third-party ML libraries: use
the model repositories configured in the application and keep dependencies updated.

Do not include recordings, transcripts, access tokens, or model caches in issues
or pull requests. Hugging Face tokens are used for model downloads and are not
saved by the application. Known token patterns are redacted from speaker setup
errors.

After publishing this repository, enable GitHub's private vulnerability reporting
in repository settings and use that channel for sensitive reports. Avoid public
issues containing credentials or private audio.
