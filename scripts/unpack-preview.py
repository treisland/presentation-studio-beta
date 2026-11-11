"""Bounded static artifact extraction. No archive paths or executable PR files are accepted."""
import hashlib
import json
import re
import stat
import sys
import zipfile
from pathlib import Path

FILES = {'index.html', 'blank.html', 'version.json', 'distribution.json', 'docs/index.html'}

def unpack(archive, output, expected_head):
    if not re.fullmatch(r'[a-f0-9]{40}', expected_head):
        raise ValueError('Expected full source SHA')
    with zipfile.ZipFile(archive) as z:
        entries = z.infolist()
        if len(entries) != len(FILES) or {e.filename for e in entries} != FILES:
            raise ValueError('Unexpected or duplicate artifact paths')
        if sum(e.file_size for e in entries) > 12_000_000:
            raise ValueError('Expanded artifact exceeds limit')
        data = {}
        for entry in entries:
            mode = entry.external_attr >> 16
            if stat.S_ISLNK(mode) or entry.is_dir() or entry.file_size > 5_000_000:
                raise ValueError('Unsupported archive entry')
            with z.open(entry) as stream:
                value = stream.read(5_000_001)
            if len(value) != entry.file_size:
                raise ValueError('Invalid entry size')
            data[entry.filename] = value
    receipt = json.loads(data['distribution.json'])
    info = json.loads(data['version.json'])
    if receipt.get('review') is not True or receipt.get('channel') != 'review' or receipt.get('sourceHead') != expected_head or info.get('channel') != 'development' or info.get('commit') != receipt.get('commit'):
        raise ValueError('Preview identity mismatch')
    for name in ('index.html', 'blank.html'):
        if hashlib.sha256(data[name]).hexdigest() != receipt['payload'][name]:
            raise ValueError('Payload digest mismatch')
        match = re.search(rb'<script id="studio-build-info" type="application/json">([^<]+)</script>', data[name])
        if not match or json.loads(match[1]) != info:
            raise ValueError('Embedded identity mismatch')
    output = Path(output)
    if output.exists():
        raise ValueError('Use a new empty deployment directory')
    for name, value in data.items():
        target = output / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(value)

if __name__ == '__main__':
    unpack(*sys.argv[1:])
