"""Reproduce every AcroForm field, widget copy and declared limit from pinned2025 forms."""
from pypdf import PdfReader
from pathlib import Path
import ast
import json,hashlib,re,sys
root=Path(__file__).parent;rows=[]
for item in json.loads((root/'manifest.json').read_text()):
 stem=Path(item['file']).stem
 if stem not in ['it201','it215','it270','it2105-9','it2']:continue
 assert hashlib.sha256((root/item['file']).read_bytes()).hexdigest()==item['documentHash']
 reader=PdfReader(root/item['file'])
 def walk(ref,prefix=''):
  field=ref.get_object();name=field.get('/T');qualified=prefix+'.'+name if prefix and name else name or prefix
  kids=field.get('/Kids',[])
  named=[kid for kid in kids if kid.get_object().get('/T')]
  if named:
   for kid in named:walk(kid,qualified)
   return
  states=set()
  for ref in kids or [ref]:
   ap=ref.get_object().get('/AP',{}).get('/N',{})
   if field.get('/FT')=='/Btn' and hasattr(ap,'keys') and not hasattr(ap,'get_data'):states.update(str(state).lstrip('/') for state in ap.keys() if state!='/Off')
  rows.append(dict(formId={'it201':'IT-201','it215':'IT-215','it270':'IT-270','it2105-9':'IT-2105.9','it2':'IT-2'}[stem],fieldId=qualified,kind=str(field.get('/FT','')),label=str(field.get('/TU','')),maxLength=field.get('/MaxLen'),widgetCount=max(1,len(kids)),states=sorted(states),choices=[str(v[0] if isinstance(v,list) else v) for v in field.get('/Opt',[])],sourceId=item['id'],sourceHash=item['documentHash']))
 for field in reader.trailer['/Root']['/AcroForm']['/Fields']:walk(field)
jsonfile=root/'field-catalog.json';ts=root.parent/'field-catalog-data.ts'
if '--write' in sys.argv:
 jsonfile.write_text(json.dumps(rows,indent=2)+'\n');ts.write_text('// Generated from pinned2025 NY AcroForms by sources/extract-fields.py.\nexport const NY_FIELD_CATALOG_DATA = '+json.dumps(rows)+' as const;\n')
else:
 assert json.loads(jsonfile.read_text())==rows
 text=ts.read_text();obj=text[text.index('=')+1:text.rindex(' as const;')]
 obj=re.sub(r'\b(formId|fieldId|kind|label|maxLength|widgetCount|states|choices|sourceId|sourceHash)\s*:',r'"\1":',obj)
 obj=re.sub(r',\s*([}\]])',r'\1',obj)
 assert ast.literal_eval(obj.replace(': null', ': None'))==rows
print(str(len(rows))+' NY AcroForm field bindings verified')
