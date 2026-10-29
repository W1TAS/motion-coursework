#!/usr/bin/env python3
"""Build the offline prototype using official Android SDK platform/build tools, no Gradle."""
from pathlib import Path
import argparse,subprocess,zipfile,shutil,os
ROOT=Path(__file__).resolve().parent
p=argparse.ArgumentParser();p.add_argument('--sdk',type=Path,default=Path(os.environ.get('ANDROID_HOME','/tmp/cp-android-sdk')));a=p.parse_args()
platform=next((p for p in [a.sdk/'platforms/android-35/android.jar',a.sdk/'android-35/android.jar'] if p.exists()),None)
aapt=next((p for p in [a.sdk/'build-tools/35.0.0/aapt2',a.sdk/'android-15/aapt2'] if p.exists()),None)
if not platform or not aapt:raise SystemExit('Need Android SDK platform 35 and build-tools 35. Pass --sdk PATH.')
tools=aapt.parent;build=ROOT/'build';build.mkdir(exist_ok=True)
classes=build/'classes';shutil.rmtree(classes,ignore_errors=True);classes.mkdir()
def run(*cmd):subprocess.run([str(x) for x in cmd],check=True)
compiled=build/'resources.zip'
run(aapt,'compile','--dir',ROOT/'android/res','-o',compiled)
apk=build/'base.apk'
run(aapt,'link','-o',apk,'--manifest',ROOT/'android/AndroidManifest.xml','-I',platform,'-A',ROOT/'app',compiled)
sources=list((ROOT/'android/src').rglob('*.java'))
run('javac','--release','8','-encoding','UTF-8','-classpath',platform,'-d',classes,*sources)
dex=build/'dex';dex.mkdir(exist_ok=True)
run('java','-cp',tools/'lib/d8.jar','com.android.tools.r8.D8','--min-api','26','--lib',platform,'--output',dex,*classes.rglob('*.class'))
with zipfile.ZipFile(apk,'a',zipfile.ZIP_DEFLATED) as z:z.write(dex/'classes.dex','classes.dex')
aligned=build/'aligned.apk';run(tools/'zipalign','-f','-p','4',apk,aligned)
keys=ROOT/'.local';keys.mkdir(exist_ok=True);keystore=keys/'prototype.keystore'
if not keystore.exists():run('keytool','-genkeypair','-keystore',keystore,'-storepass','android','-keypass','android','-alias','prototype','-keyalg','RSA','-keysize','2048','-validity','3650','-dname','CN=BSUIR Coursework Prototype')
output=ROOT/'downloads/motion-prototype.apk';output.parent.mkdir(exist_ok=True)
run('java','-jar',tools/'lib/apksigner.jar','sign','--ks',keystore,'--ks-pass','pass:android','--key-pass','pass:android','--out',output,aligned)
run('java','-jar',tools/'lib/apksigner.jar','verify','--verbose',output)
print(f'APK: {output} ({output.stat().st_size/1024/1024:.1f} MiB)')
