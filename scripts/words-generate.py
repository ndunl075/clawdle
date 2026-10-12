"""Rebuild bundled dictionaries offline from pinned ESDB source. Python 3.12+.
Use --check in CI. No network access; temporary upstream DB never enters bundles.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parents[1]
WORDS = ROOT / 'assets/words'
REVISION = '1e5b7d3a72f47a71da5d28686c1dd4b397178485'
ARCHIVE = WORDS / 'esdb-1e5b7d3.zip'
def sha(value):
    return hashlib.sha256(value).hexdigest()
def text_json(value):
    return (json.dumps(value, ensure_ascii=True, indent=2) + '\n').encode()
def lines(path):
    return [word.upper() for line in path.read_text().splitlines() if not line.startswith('#') for word in line.split()]
def main():
    check = argparse.ArgumentParser()
    check.add_argument('--check', action='store_true')
    args = check.parse_args()
    with tempfile.TemporaryDirectory(prefix='clawdle-esdb-') as tmp:
        source = Path(tmp)
        with zipfile.ZipFile(ARCHIVE) as archive:
            archive.extractall(source)
        env = dict(os.environ, PYTHONUTF8='1', PYTHONDONTWRITEBYTECODE='1')
        subprocess.run([sys.executable,'combine.py','create-db','scowl.db'],cwd=source,env=env,check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        result = subprocess.run([sys.executable,'-m','libscowl','word-list','70','A','1','--wo-poses=abbr','--deaccent'],cwd=source,env=env,check=True,capture_output=True)
        guesses = {w.upper() for w in result.stdout.decode().splitlines() if re.fullmatch('[a-z]{5}',w)}
        guesses.update(lines(WORDS/'inclusions.txt'))
        guesses.difference_update(lines(WORDS/'exclusions.txt'))
        answers = sorted(set(lines(WORDS/'answers-curated.txt')))
        # Curated common answers may be included explicitly, with project authorship.
        guesses.update(answers)
        if any(not re.fullmatch('[A-Z]{5}',w) for w in guesses):
            raise ValueError('Invalid word')
        frozen = WORDS/'daily-v1.json'
        # Freeze schedule permanently. Only first-time creation uses deterministic hash order.
        daily = json.loads(frozen.read_text()) if frozen.exists() else [f'en-v1:{w.lower()}' for w in sorted(answers,key=lambda w:sha(('clawdle-daily-v1:'+w).encode()))]
        if len(daily)!=len(set(daily)) or any(w[6:].upper() not in answers for w in daily):
            raise ValueError('Schedule references missing or repeated answers')
        outputs = {
            WORDS/'answers-v1.json': text_json(answers),
            WORDS/'guesses-v1.txt': ('\n'.join(sorted(guesses))+'\n').encode(),
            frozen: text_json(daily),
            ROOT/'packages/game/src/words.generated.json':text_json({'answers':answers,'guesses':sorted(guesses),'daily':daily}),
            ROOT/'assets/licenses/ESDB-Copyright.txt':(source/'Copyright').read_bytes(),
        }
        manifest = {'sourceUrl':'https://github.com/en-wl/wordlist','sourceRevision':REVISION,'sourceArchive':ARCHIVE.name,'sourceChecksum':sha(ARCHIVE.read_bytes()),'generationOptions':{'size':70,'spelling':'A','variantLevel':1,'excludePos':['abbr'],'deaccent':True,'filter':'^[a-z]{5}$; uppercase; project inclusions/exclusions; independently curated answers'},'noticeChecksum':sha(outputs[ROOT/'assets/licenses/ESDB-Copyright.txt']),'dictionaryVersion':'en-v1','scheduleVersion':'daily-v1','referenceDate':'2026-10-12T00:00:00Z','checksums':{str(p.relative_to(ROOT)).replace('\\','/'):sha(v) for p,v in outputs.items()},'entryCounts':{'answers':len(answers),'guesses':len(guesses),'daily':len(daily)}}
        outputs[WORDS/'manifest.json']=text_json(manifest)
        failed=[]
        for path,content in outputs.items():
            if args.check:
                if not path.exists() or path.read_bytes()!=content: failed.append(str(path.relative_to(ROOT)))
            else:
                path.parent.mkdir(parents=True,exist_ok=True)
                path.write_bytes(content)
        if failed: raise SystemExit('Dictionary reproduction failed: '+', '.join(failed))
        print(f"{'Verified' if args.check else 'Generated'} {len(guesses)} guesses, {len(answers)} answers, frozen {len(daily)}-day schedule")
if __name__=='__main__': main()
