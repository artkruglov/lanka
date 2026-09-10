"""Bounded source extraction. Never executes macros, external links, or archive paths."""
import sys, json, zipfile, subprocess, re, posixpath
from pathlib import Path
from xml.etree import ElementTree as ET

MAX_TOTAL=100_000
def extract(path,name):
    ext=Path(name).suffix.lower(); fragments=[]; remaining=MAX_TOTAL; partial=False
    def add(locator,text):
        nonlocal remaining,partial
        text=text.strip()
        if not text:return
        if remaining<=0 or len(fragments)>=80:partial=True;return
        for start in range(0,len(text),2000):
            if remaining<=0 or len(fragments)>=80:partial=True;break
            part=text[start:start+min(2000,remaining)]
            if len(part)<min(2000,len(text)-start):partial=True
            fragments.append({'locator':locator if start==0 else f'{locator} · фрагмент {start//2000+1}','text':part});remaining-=len(part)
    if ext in ['.txt','.md','.csv','.json']:
        text=Path(path).read_text(encoding='utf-8-sig');add('Текст',text)
    elif ext=='.pdf':
        r=subprocess.run(['pdftotext','-f','1','-l','50','-layout',str(path),'-'],capture_output=True,timeout=20)
        if r.returncode:raise ValueError('Не удалось извлечь текст PDF')
        for i,page in enumerate(r.stdout.decode('utf-8',errors='replace').split('\f')):add(f'Страница {i+1}',page)
        partial=True # Explicit page cap; scanned pages require OCR.
    elif ext in ['.docx','.pptx','.xlsx']:
        with zipfile.ZipFile(path) as archive:
            entries=archive.infolist()
            if len(entries)>2500 or sum(i.file_size for i in entries)>40_000_000 or any(i.file_size>8_000_000 for i in entries):raise ValueError('Архив превышает ограничения распаковки')
            def xml(name):
                data=archive.read(name)
                if b'<!DOCTYPE' in data or b'<!ENTITY' in data:raise ValueError('XML с сущностями не поддерживается')
                return ET.fromstring(data)
            def texts(root):return ' '.join(n.text or '' for n in root.iter() if n.tag.rsplit('}',1)[-1]=='t')
            if ext=='.docx':
                for i,p in enumerate(n for n in xml('word/document.xml').iter() if n.tag.rsplit('}',1)[-1]=='p'):add(f'Абзац {i+1}',texts(p))
            elif ext=='.pptx':
                files=sorted((n for n in archive.namelist() if re.fullmatch(r'ppt/slides/slide\d+\.xml',n)),key=lambda n:int(re.search(r'(\d+)\.xml',n)[1]))
                ordered=False
                if 'ppt/presentation.xml' in archive.namelist() and 'ppt/_rels/presentation.xml.rels' in archive.namelist():
                    # Package-absolute targets start at the ZIP root, never the host filesystem.
                    relations={r.attrib.get('Id'):posixpath.normpath(r.attrib.get('Target','').lstrip('/') if r.attrib.get('Target','').startswith('/') else posixpath.join('ppt',r.attrib.get('Target',''))) for r in xml('ppt/_rels/presentation.xml.rels') if r.attrib.get('TargetMode')!='External'}
                    ids=[next((v for k,v in slide.attrib.items() if k.endswith('}id')),None) for slide in xml('ppt/presentation.xml').iter() if slide.tag.rsplit('}',1)[-1]=='sldId']
                    available=set(files)
                    partial=any(rid not in relations or relations[rid] not in available for rid in ids)
                    # Retain the original ordinal if an unreadable slide is skipped.
                    files=[(i+1,relations[rid]) for i,rid in enumerate(ids) if rid in relations and relations[rid] in available]
                    ordered=True
                else:files=list(enumerate(files,1))
                for i,n in files[:80]:add(f'Слайд {i}' if ordered else n,texts(xml(n)))
                partial=partial or len(files)>80 or not ordered
            else:
                strings=[texts(si) for si in xml('xl/sharedStrings.xml')] if 'xl/sharedStrings.xml' in archive.namelist() else []
                files=sorted(n for n in archive.namelist() if re.fullmatch(r'xl/worksheets/sheet\d+\.xml',n))
                for n in files[:20]:
                    for cell in xml(n).iter():
                        if cell.tag.rsplit('}',1)[-1]!='c':continue
                        value=next((x.text or '' for x in cell if x.tag.rsplit('}',1)[-1]=='v'),'')
                        formula=next((x.text or '' for x in cell if x.tag.rsplit('}',1)[-1]=='f'),None)
                        if cell.attrib.get('t')=='s':value=strings[int(value)] if value else ''
                        if cell.attrib.get('t')=='inlineStr':value=texts(cell)
                        if formula is not None:value=f'Формула: {formula}; сохранённое значение: {value or "отсутствует"}'
                        add(f'{Path(n).stem}!{cell.attrib.get("r","?")}',value)
                partial=True # Cached formula values are not recalculated; styles/charts are not extracted.
    else:return {'status':'unsupported','note':'Из этого формата текст не извлекается. Изображения доступны как отдельные материалы.','fragments':[]}
    if not fragments:return {'status':'failed','note':'Текст не найден. Для сканов нужен OCR.','fragments':[]}
    partial_note={'.pdf':'Текст PDF извлечён частично: проверяются первые 50 страниц; изображения и сканы требуют OCR.', '.xlsx':'Извлечены ограниченные данные таблиц: формулы не пересчитывались, оформление и графики не читались.', '.pptx':'Текст презентации извлечён частично: достигнут лимит текста/слайдов либо часть слайдов или их порядок недоступны.'}.get(ext,'Текст извлечён частично: достигнут лимит объёма или количества фрагментов.')
    return {'status':'partial' if partial else 'extracted','note':partial_note if partial else 'Текст извлечён. Форматирование не переносилось.','fragments':fragments}

if __name__=='__main__':
    try:
        import resource
        resource.setrlimit(resource.RLIMIT_AS,(300_000_000,300_000_000))
        resource.setrlimit(resource.RLIMIT_CPU,(20,20))
    except (ImportError,ValueError):pass
    try: result=extract(sys.argv[1],sys.argv[2])
    except Exception:result={'status':'failed','note':'Не удалось безопасно извлечь текст из файла. Проверьте формат или загрузите текстовую копию.','fragments':[]}
    print(json.dumps(result,ensure_ascii=False))
