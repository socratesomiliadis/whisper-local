"""Verify that built wheels include the UI, and never local data."""

from pathlib import Path
from zipfile import ZipFile

wheel = next(Path("dist").glob("*.whl"))
with ZipFile(wheel) as archive:
    names = set(archive.namelist())
    for asset in (
        "templates/index.html",
        "static/app.js",
        "static/style.css",
        "static/icon.svg",
    ):
        assert f"whisper_local/{asset}" in names, f"Missing packaged asset: {asset}"
    assert not any(".runtime/" in name or ".models/" in name for name in names)
print(f"Verified package assets in {wheel.name}")
