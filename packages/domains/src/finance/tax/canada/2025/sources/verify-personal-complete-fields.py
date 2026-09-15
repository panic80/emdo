import json,xml.etree.ElementTree as ET,hashlib
from pathlib import Path
from pypdf import PdfReader
import sys
root=Path(__file__).resolve().parent;fields=[]
for src in json.loads((root/'personal-precision-capture-manifest.json').read_text()):
 pdf=root/src['localFile'];assert hashlib.sha256(pdf.read_bytes()).hexdigest()==src['documentHash']
 packets=PdfReader(pdf).trailer['/Root']['/AcroForm'].get_object()['/XFA'];data=next(packets[i+1].get_object().get_data() for i in range(0,len(packets),2) if str(packets[i])=='template');tree=ET.fromstring(data);ns={'x':tree.tag.split('}')[0][1:]}
 def walk(el,path):
  name=el.attrib.get('name');path=path+([name] if name else [])
  if el.tag.endswith('}field'):
   ui=el.find('x:ui',ns);kinds=[c.tag.split('}')[-1] for c in ui] if ui is not None else []
   fields.append(dict(sourceId=src['id'],path='.'.join(path),kind=next((k for k in kinds if k not in ['picture','extras']),'unknown'),label=el.findtext('x:assist/x:speak','',ns),access=el.attrib.get('access','open'),defaultValue=''.join(el.find('x:value',ns).itertext()) if el.find('x:value',ns) is not None else None))
  for c in el:walk(c,path)
 walk(tree,[])

counts={}
for field in fields:
 key=(field['sourceId'],field['path']);field['occurrence']=counts.get(key,0);counts[key]=field['occurrence']+1
json_text=json.dumps(fields,indent=2)+'\n'
ts_text="// Generated from SHA-256-pinned CRA XFA templates; regenerate with sources/verify-personal-complete-fields.py --write.\nimport { deepFreeze } from '@emdo/contracts';\n// prettier-ignore\nexport const PERSONAL_COMPLETE_FIELD_CATALOG = deepFreeze("+json.dumps(fields,separators=(',',':'))+");\n"
if '--write' in sys.argv:
 (root/'personal-complete-field-catalog.json').write_text(json_text)
 (root.parent/'personal-field-catalog.ts').write_text(ts_text)
else:
 assert json.loads((root/'personal-complete-field-catalog.json').read_text())==fields
 assert (root.parent/'personal-field-catalog.ts').read_text()==ts_text
print(f'Verified {len(fields)} field instances across seven captured CRA forms')
