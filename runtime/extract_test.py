import unittest, tempfile, zipfile
from pathlib import Path
from extract import extract

class SourceExtractionTests(unittest.TestCase):
    def zip(self,files):
        directory=tempfile.TemporaryDirectory();self.addCleanup(directory.cleanup)
        p=Path(directory.name)/'source.zip'
        with zipfile.ZipFile(p,'w') as z:
            for name,text in files.items():z.writestr(name,text)
        return p
    def test_docx_paragraph_anchor(self):
        p=self.zip({'word/document.xml':'<w:document xmlns:w="urn:word"><w:p><w:r><w:t>Выручка выросла</w:t></w:r></w:p></w:document>'})
        r=extract(p,'source.docx');self.assertEqual(r['fragments'][0],{'locator':'Абзац 1','text':'Выручка выросла'})
    def test_pptx_numeric_slide_order(self):
        p=self.zip({'ppt/slides/slide10.xml':'<s><t>Десятый</t></s>','ppt/slides/slide2.xml':'<s><t>Второй</t></s>'})
        r=extract(p,'source.pptx');self.assertEqual(r['fragments'][0]['text'],'Второй')
    def test_xlsx_formula_is_not_recalculated(self):
        p=self.zip({'xl/worksheets/sheet1.xml':'<sheet><c r="C5"><f>A1+B1</f><v>42</v></c></sheet>'})
        r=extract(p,'source.xlsx');self.assertEqual(r['status'],'partial');self.assertEqual(r['fragments'][0]['locator'],'sheet1!C5');self.assertIn('сохранённое значение: 42',r['fragments'][0]['text'])
    def test_pptx_uses_presentation_order_instead_of_file_numbers(self):
        p=self.zip({'ppt/slides/slide1.xml':'<s><t>Second</t></s>','ppt/slides/slide2.xml':'<s><t>First</t></s>','ppt/presentation.xml':'<p xmlns:r="urn:rels"><sldId r:id="b"/><sldId r:id="a"/></p>','ppt/_rels/presentation.xml.rels':'<Relationships><Relationship Id="a" Target="slides/slide1.xml"/><Relationship Id="b" Target="slides/slide2.xml"/></Relationships>'})
        r=extract(p,'source.pptx');self.assertEqual(r['fragments'][0],{'locator':'Слайд 1','text':'First'});self.assertEqual(r['fragments'][1]['text'],'Second')
    def test_external_entities_rejected(self):
        p=self.zip({'word/document.xml':'<!DOCTYPE x [<!ENTITY unsafe SYSTEM "file:///etc/passwd">]><document>&unsafe;</document>'})
        with self.assertRaises(ValueError):extract(p,'source.docx')
    def test_image_is_not_fake_ocr(self):
        r=extract('/unused','image.png');self.assertEqual(r['status'],'unsupported');self.assertEqual(r['fragments'],[])

if __name__=='__main__':unittest.main()
