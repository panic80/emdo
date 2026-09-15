"""Read-only verification of captured public CRA XFA numeric evidence (requires pypdf)."""
import hashlib
import json
from pathlib import Path
import xml.etree.ElementTree as ET
from pypdf import PdfReader

root = Path(__file__).resolve().parent
expected = json.loads((root / 'personal-precision-field-catalog.json').read_text())
actual = []
for capture in json.loads((root / 'personal-precision-capture-manifest.json').read_text()):
    pdf = root / capture['localFile']
    assert hashlib.sha256(pdf.read_bytes()).hexdigest() == capture['documentHash']
    packets = PdfReader(pdf).trailer['/Root']['/AcroForm'].get_object()['/XFA']
    template = next(packets[i + 1].get_object().get_data()
                    for i in range(0, len(packets), 2) if str(packets[i]) == 'template')
    tree = ET.fromstring(template)
    ns = {'x': tree.tag.split('}')[0][1:]}
    def walk(element, path):
        name = element.attrib.get('name')
        path = path + ([name] if name else [])
        if element.tag.endswith('}field') and element.find('x:ui/x:numericEdit', ns) is not None:
            actual.append(dict(sourceId=capture['id'], path='.'.join(path), name=name,
                               label=element.findtext('x:assist/x:speak', default='', namespaces=ns),
                               inputPattern=element.findtext('x:ui/x:picture', default='', namespaces=ns),
                               displayPattern=element.findtext('x:format/x:picture', default='', namespaces=ns),
                               changeScripts=[s.text or '' for s in element.findall('x:event[@activity="change"]/x:script', ns)]))
        for child in element:
            walk(child, path)
    walk(tree, [])
assert actual == expected, 'Captured catalog differs from actual PDF template'
print(f'Verified {len(actual)} numeric fields against {len(json.loads((root / "personal-precision-capture-manifest.json").read_text()))} source-hashed CRA PDFs')
