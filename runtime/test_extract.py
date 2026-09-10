"""Source fidelity regressions; fixtures contain synthetic, non-executable Office XML."""
import importlib.util
from pathlib import Path
import tempfile
import unittest
import zipfile
from xml.sax.saxutils import escape

spec = importlib.util.spec_from_file_location('source_extractor', Path(__file__).with_name('extract.py'))
extractor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(extractor)


class ExtractionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / 'source'

    def pptx(self, texts, targets=None, order=None, with_order=True):
        targets = targets or {str(i): f'slides/slide{i}.xml' for i in texts}
        order = order or list(targets)
        with zipfile.ZipFile(self.path, 'w') as archive:
            for number, text in texts.items():
                archive.writestr(f'ppt/slides/slide{number}.xml', f'<slide><t>{escape(text)}</t></slide>')
            if with_order:
                archive.writestr('ppt/presentation.xml', '<presentation xmlns:r="urn:relationships">' + ''.join(f'<sldId r:id="r{i}"/>' for i in order) + '</presentation>')
                archive.writestr('ppt/_rels/presentation.xml.rels', '<Relationships>' + ''.join(f'<Relationship Id="r{i}" Target="{target}"/>' for i, target in targets.items()) + '</Relationships>')
        return extractor.extract(self.path, 'report.pptx')

    def test_presentation_order_is_preserved(self):
        result = self.pptx({1: 'Первый файл', 2: 'Второй файл'}, order=['2', '1'])
        self.assertEqual(result['status'], 'extracted')
        self.assertEqual(result['fragments'], [{'locator':'Слайд 1', 'text':'Второй файл'}, {'locator':'Слайд 2', 'text':'Первый файл'}])

    def test_package_absolute_targets_are_read(self):
        result = self.pptx({1: '42 заявки'}, targets={'1':'/ppt/slides/slide1.xml'})
        self.assertEqual(result['status'], 'extracted')
        self.assertEqual(result['fragments'][0]['text'], '42 заявки')

    def test_missing_slide_keeps_gap_and_reports_partial(self):
        result = self.pptx({1: 'Начало', 3: 'Конец'}, targets={'1':'slides/slide1.xml', '2':'slides/missing.xml', '3':'slides/slide3.xml'})
        self.assertEqual(result['status'], 'partial')
        self.assertEqual([f['locator'] for f in result['fragments']], ['Слайд 1', 'Слайд 3'])
        self.assertNotIn('PDF', result['note'])

    def test_unresolved_relationship_is_not_silently_ignored(self):
        result = self.pptx({1: 'Данные'}, order=['missing','1'])
        self.assertEqual(result['status'], 'partial')
        self.assertEqual(result['fragments'][0]['locator'], 'Слайд 2')

    def test_text_cap_is_not_reset_after_pptx_read(self):
        result = self.pptx({1: 'А' * (extractor.MAX_TOTAL + 1)})
        self.assertEqual(result['status'], 'partial')
        self.assertEqual(sum(len(f['text']) for f in result['fragments']), extractor.MAX_TOTAL)

    def test_fragment_cap_is_not_reset_after_pptx_read(self):
        result = self.pptx({i: 'Факт' for i in range(1,82)})
        self.assertEqual(result['status'], 'partial')
        self.assertEqual(len(result['fragments']), 80)

    def test_last_chunk_truncation_is_reported(self):
        # Remaining budget is not a multiple of the 2000-character chunk size.
        result = self.pptx({1: 'А', 2: 'Б' * extractor.MAX_TOTAL})
        self.assertEqual(result['status'], 'partial')
        self.assertEqual(sum(len(f['text']) for f in result['fragments']), extractor.MAX_TOTAL)

    def test_exact_limit_is_complete(self):
        result = self.pptx({1: 'Б' * extractor.MAX_TOTAL})
        self.assertEqual(result['status'], 'extracted')

    def test_unordered_fallback_is_partial_and_names_files(self):
        result = self.pptx({10: 'Десятый', 2: 'Второй'}, with_order=False)
        self.assertEqual(result['status'], 'partial')
        self.assertEqual(result['fragments'][0]['locator'], 'ppt/slides/slide2.xml')

    def test_text_over_limit_is_partial_with_relevant_note(self):
        self.path.write_text('Т' * (extractor.MAX_TOTAL + 1), encoding='utf8')
        result = extractor.extract(self.path, 'report.txt')
        self.assertEqual(result['status'], 'partial')
        self.assertNotIn('PDF', result['note'])

    def test_no_readable_content_is_not_success(self):
        self.assertEqual(self.pptx({1: ''})['status'], 'failed')
        self.assertEqual(extractor.extract(self.path, 'unsupported.bin')['status'], 'unsupported')


if __name__ == '__main__':
    unittest.main()
