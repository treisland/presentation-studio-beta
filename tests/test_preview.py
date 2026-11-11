import hashlib
import importlib.util
import json
import tempfile
import unittest
import zipfile
from pathlib import Path

spec = importlib.util.spec_from_file_location('preview', Path(__file__).parents[1] / 'scripts/unpack-preview.py')
preview = importlib.util.module_from_spec(spec)
spec.loader.exec_module(preview)

class PreviewTests(unittest.TestCase):
    def sample(self):
        info = {'version': '0.9.0-beta.1', 'commit': 'a' * 40, 'channel': 'development'}
        html = ('<script id="studio-build-info" type="application/json">' + json.dumps(info) + '</script>').encode()
        return {'index.html': html, 'blank.html': html, 'version.json': json.dumps(info).encode(),
                'docs/index.html': b'<h1>Help</h1>', 'distribution.json': json.dumps({
                    'review': True, 'channel': 'review', 'sourceHead': 'b' * 40, 'commit': info['commit'],
                    'payload': {name: hashlib.sha256(html).hexdigest() for name in ('index.html', 'blank.html')}}).encode()}

    def check(self, files, failure=False):
        with tempfile.TemporaryDirectory() as directory:
            archive, output = Path(directory) / 'site.zip', Path(directory) / 'site'
            with zipfile.ZipFile(archive, 'w') as z:
                for name, data in files.items():
                    z.writestr(name, data)
            if failure:
                with self.assertRaises(ValueError):
                    preview.unpack(archive, output, 'b' * 40)
                self.assertFalse(output.exists())
            else:
                preview.unpack(archive, output, 'b' * 40)
                self.assertEqual((output / 'index.html').read_bytes(), files['index.html'])

    def test_valid_static_artifact(self):
        self.check(self.sample())

    def test_traversal_and_unexpected_files(self):
        for bad in ('../escape', '/absolute', 'package.json', 'docs/../../escape'):
            files = self.sample()
            files[bad] = files.pop('docs/index.html')
            self.check(files, True)

    def test_tampered_payload_and_wrong_identity(self):
        files = self.sample()
        files['index.html'] += b'tampered'
        self.check(files, True)
        files = self.sample()
        files['version.json'] = files['version.json'].replace(b'development', b'stable')
        self.check(files, True)

    def test_symlinks_and_expansion_limits(self):
        for symlink in (True, False):
            with tempfile.TemporaryDirectory() as directory:
                archive, output = Path(directory) / 'site.zip', Path(directory) / 'site'
                with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_DEFLATED) as z:
                    for name, data in self.sample().items():
                        entry = zipfile.ZipInfo(name)
                        if name == 'index.html':
                            if symlink:
                                entry.external_attr = 0o120777 << 16
                            else:
                                data = b'x' * 5_000_001
                        z.writestr(entry, data)
                with self.assertRaises(ValueError):
                    preview.unpack(archive, output, 'b' * 40)
                self.assertFalse(output.exists())

if __name__ == '__main__':
    unittest.main()
