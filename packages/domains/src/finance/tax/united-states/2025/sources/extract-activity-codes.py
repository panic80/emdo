"""Verify published ScheduleC activity codes from the pinned IRS instruction PDF."""
import hashlib,json,re,subprocess,sys
from pathlib import Path
root=Path(__file__).parent
source=next(row for row in json.loads((root/'manifest.json').read_text()) if row['id']=='irs-2025-i1040sc')
assert hashlib.sha256((root/source['file']).read_bytes()).hexdigest()==source['documentHash']
text=subprocess.check_output(['pdftotext','-layout',str(root/source['file']),'-'],text=True)
codes=sorted(set(re.findall(r'\b\d{6}\b',text)))
assert len(codes)==304 and '541600' in codes and '541611' not in codes
module=(root.parent/'activity-codes.ts').read_text()
actual=re.findall(r"['\"](\d{6})['\"]",module)
assert actual==codes
print('304 published ScheduleC activity codes verified')
