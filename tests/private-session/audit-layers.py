"""Scan exported Docker metadata and every unpacked layer for synthetic markers."""
import io
import json
import tarfile
import pathlib

root = pathlib.Path('/audit')
markers = [value.encode() for value in json.loads((root / 'markers.json').read_text())]
layers = 0
files = 0
for filename in ('application.tar', 'context.tar'):
    with tarfile.open(root / filename) as archive:
        for item in archive:
            if not item.isfile():
                continue
            data = archive.extractfile(item).read()
            assert not any(marker in data for marker in markers), 'Synthetic marker in Docker archive'
            try:
                layer = tarfile.open(fileobj=io.BytesIO(data), mode='r:*')
            except tarfile.ReadError:
                continue
            layers += 1
            with layer:
                for entry in layer:
                    if not entry.isfile():
                        continue
                    files += 1
                    content = layer.extractfile(entry).read()
                    assert not any(marker in content for marker in markers), 'Synthetic marker in Docker layer'
                    if filename == 'context.tar':
                        assert 'qualification-cookies-' not in entry.name and '.env.qualification-' not in entry.name, 'Excluded fixture in build context'
print(json.dumps({'name': 'Docker context, metadata and every layer exclude runtime markers', 'status': 'pass', 'layers': layers, 'files': files}))
