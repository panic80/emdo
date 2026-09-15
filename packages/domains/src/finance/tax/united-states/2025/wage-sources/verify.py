"""Verify pinned IRS correction authority; never silently refresh."""
import hashlib,json
from pathlib import Path
root=Path(__file__).parent
source=json.loads((root/'manifest.json').read_text())
assert source['url']=='https://www.irs.gov/pub/irs-prior/iw2w3--2025.pdf'
assert hashlib.sha256((root/'iw2w3.pdf').read_bytes()).hexdigest()==source['documentHash']
print('1 IRS2025 wage-correction source verified')
