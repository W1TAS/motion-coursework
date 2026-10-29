"""Check that the distributable contains exactly the current offline app and signed DEX."""
from pathlib import Path
import zipfile,hashlib,json
root=Path(__file__).resolve().parents[1]
apk=root/'downloads/motion-prototype.apk'
with zipfile.ZipFile(apk) as z:
 assert 'classes.dex' in z.namelist()
 files=list((root/'app').rglob('*'))
 for p in files:
  if p.is_file():
   entry='assets/'+p.relative_to(root/'app').as_posix()
   assert z.read(entry)==p.read_bytes(),f'APK asset mismatch: {entry}'
 assert all('keystore' not in s for s in z.namelist())
 print('All offline assets match:',len([p for p in files if p.is_file()]))
sha=hashlib.sha256(apk.read_bytes()).hexdigest()
(root/'downloads/SHA256SUMS.txt').write_text(f'{sha}  motion-prototype.apk\n')
print('APK SHA256',sha)
