"""Verify immutable IRS 2025 captures; never replace evidence with a current download."""
import hashlib
import json
from pathlib import Path

root = Path(__file__).parent
for source in json.loads((root / 'manifest.json').read_text()):
    data = (root / source['file']).read_bytes()
    assert hashlib.sha256(data).hexdigest() == source['documentHash'], source['file']
    assert source['url'].startswith('https://www.irs.gov/'), source['url']
print('19 IRS 2025 source captures verified')
