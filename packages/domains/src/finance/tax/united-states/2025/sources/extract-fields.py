"""Reproduce form-field identifiers, accessible labels and declared text limits from IRS XFA."""
import hashlib,json,sys
from pathlib import Path
from pypdf import PdfReader
import xml.etree.ElementTree as E
root=Path(__file__).parent
manifest=json.loads((root/'manifest.json').read_text())
forms={'f1040':'F1040','f1040sc':'C','f1040sse':'SE','f1040s1':'S1','f1040s2':'S2','f8995':'F8995','f6251':'F6251','f8959':'F8959','f2210':'F2210'}
rows=[]
for source in manifest:
 stem=Path(source['file']).stem
 if stem not in forms: continue
 data=(root/source['file']).read_bytes();assert hashlib.sha256(data).hexdigest()==source['documentHash']
 reader=PdfReader(root/source['file']);xfa=reader.trailer['/Root']['/AcroForm']['/XFA'];template=E.fromstring(xfa[xfa.index('template')+1].get_object().get_data());ns={'x':template.tag.split('}')[0][1:]}
 seen={}
 for field in template.findall('.//x:field',ns):
  name=field.attrib['name'];index=seen.get(name,0);seen[name]=index+1;name=f'{name}[{index}]'
  label=' '.join(''.join(field.find('x:assist/x:speak',ns).itertext()).split()) if field.find('x:assist/x:speak',ns) is not None else ''
  caption=' '.join(''.join(field.find('x:caption',ns).itertext()).split()) if field.find('x:caption',ns) is not None else ''
  text=field.find('x:value/x:text',ns);comb=field.find('x:ui/x:textEdit/x:comb',ns)
  rows.append(dict(formId=forms[stem],fieldId=name,label=label,caption=caption,kind='checkbox' if field.find('x:ui/x:checkButton',ns) is not None else 'text',
   maxChars=int(text.attrib['maxChars']) if text is not None and 'maxChars' in text.attrib else None,
   combCells=int(comb.attrib['numberOfCells']) if comb is not None and 'numberOfCells' in comb.attrib else None,
   sourceId=source['id'],sourceHash=source['documentHash']))
encoded=json.dumps(rows,indent=2)+'\n';target=root/'field-catalog.json'
if '--check' in sys.argv: assert target.read_text()==encoded
else:
 target.write_text(encoded)
 (root.parent/'field-catalog-data.ts').write_text('// Generated from pinned IRS XFA by sources/extract-fields.py.\nexport const IRS_FIELD_CATALOG = '+json.dumps(rows,separators=(',',':'))+' as const;\n')
print(f'{len(rows)} IRS XFA fields verified')
