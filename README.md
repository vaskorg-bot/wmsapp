# PDA Raktár (offline WMS)

Egyszerű raktárkezelő Android PDA-ra. Minden adat a készüléken tárolódik, hálózat nem kell.

Funkciók: átvétel, betárolás, kiszedés, futár átadás/rakodás manifeszttel, lokáció leltár, áthelyezés, készletlekérdezés, mozgásnapló, törzsadat (cikk, lokáció, rendelés CSV import), PIN-nel védett törzsadat, napi automatikus mentés.

## Követelmények

| | |
|---|---|
| Android | 7.0 vagy újabb (minSdk 24) |
| WebView | Android System WebView 84+ ajánlott (régebbin a térközök hiányozhatnak, a működés nem sérül) |
| Build | Node.js 22, JDK 21, Android SDK 36 (Android Studio-val együtt települ) |

## APK építése

### A) GitHub Actions (nem kell semmit telepíteni)
1. A repóban: Settings › Secrets and variables › Actions › New repository secret. Kell `KEYSTORE_BASE64` (a kulcsfájl base64 tartalma) és `KEYSTORE_PASSWORD`.
2. Minden push után az Actions fülön elindul a „Build APK” futás (kb. 5–8 perc). Kézzel: Actions › Build APK › Run workflow.
3. A futás oldalán az Artifacts alatt töltsd le a `pda-raktar-apk` zip-et, benne az `app-release.apk`.

### B) Android Studio
1. `npm ci`
2. `npm run sync`
3. Android Studio › Open › az `android` mappa.
4. Build › Build App Bundle(s) / APK(s) › Build APK(s). Az APK helye: `android/app/build/outputs/apk/debug/app-debug.apk`.

### C) Parancssor
```
npm ci
npm run apk
```

## Telepítés a PDA-ra
- **USB / fájl:** másold az APK-t a PDA-ra, nyisd meg fájlkezelőből, és engedélyezd az „Ismeretlen alkalmazások telepítése” opciót a fájlkezelőnek.
- **ADB:** `adb install -r app-release.apk`
- **Frissítés:** az új APK-t a régire telepítsd (ne távolítsd el előtte). Előtte növeld a `versionCode` értékét az `android/app/build.gradle` fájlban.

**Az aláíró kulcs nélkülözhetetlen.** Más kulccsal aláírt APK nem telepíthető a meglévőre, csak eltávolítás után, az pedig minden adatot töröl.
- A kulcs nincs a repóban. A GitHub build a `KEYSTORE_BASE64` és `KEYSTORE_PASSWORD` repository secretből állítja vissza.
- Helyi buildhez tedd az `android/app/` mappába a `pda-raktar.keystore` és `keystore.properties` fájlt (a `.gitignore` kizárja őket).
- A kulcsfájlt és a jelszót őrizd meg a repón kívül is.

## iData szkenner beállítása
iScan alkalmazás (vagy Beállítások › Scanner):
- Kimeneti mód: **billentyűzet emuláció** (keyboard output). A „direct fill” és a „broadcast” mód közül csak a direct fill működik.
- Utótag (suffix): **Enter** (ajánlott). Utótag nélkül is működik.
- Kódtípusok: EAN-13, Code 128, QR (a lokációcímkékhez Code 128 ajánlott).

## Adatok és mentés
- Az adatok az alkalmazás saját tárhelyén vannak (IndexedDB). **Az app eltávolítása vagy az alkalmazásadatok törlése mindent töröl.**
- Napi automatikus mentés: `Documents/PDA-Raktar/Mentes/pda-raktar-mentes-ÉÉÉÉ-HH-NN.json`. Az utolsó 14 nap marad meg.
- Kézi mentés, visszaállítás: Törzsadat › Mentés.
- CSV exportok: `Documents/PDA-Raktar/`. Ha a Documents mappa nem írható, a mentés az app saját mappájába kerül: `Android/data/hu.pdaraktar.wms/files/PDA-Raktar/`. Ez a mappa az app eltávolításakor törlődik.

## CSV import formátumok
Elválasztó: `;`, tab vagy vessző. A fejléc sor opcionális.

Cikkek:
```
cikkszám;megnevezés;ean;me
SKU-001;Termék neve;5991234567890|5991234567891;db
```
Rendelések (rendelésenként több sor):
```
rendelésszám;futár;cikkszám;db;címzett;követőszám;csomagszám
WEB-10045;GLS;SKU-001;2;;GLS123456;1
```

## Fejlesztés
- Forrás: `src/app.js` (alkalmazás), `src/index.html` (felület), `src/native.js` (Capacitor bővítmények).
- `npm run build` a `www/` mappába fordít (Chrome 61 cél, offline fontok).
- Böngészőben is fut tesztre (`www/index.html` helyi webszerverről). Ekkor a fájlmentés letöltésként működik.
- Alkalmazásazonosító: `hu.pdaraktar.wms` (`capacitor.config.json`, `android/app/build.gradle`). Ha módosítod, első telepítés előtt tedd.
