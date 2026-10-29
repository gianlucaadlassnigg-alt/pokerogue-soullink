# PokeRogue Soul Link

Soul-Link-Nuzlocke für zwei Spieler auf **pokerogue.net**:

- **Script im Spiel (Tampermonkey):** liest euren Run live aus, also Starter, Fänge, Tode, Welle und Biom.
- **Overlay im Spiel:** zeigt oben rechts eure verlinkten Paare und Warnungen. Mit `Strg+Shift+L` klappt ihr es ein und aus.
- **Automatisches Freilassen:** Stirbt das Pokémon deines Partners, wird dein verlinktes Pokémon automatisch freigelassen.
- **Website:** Live-Tracker mit Paaren, Live-Feed, Friedhof und früheren Runs. Es gibt keine Anmeldung, jeder mit dem Link kann zuschauen.

---

## Regeln, wie das Tool sie umsetzt

| Was | Wie |
|---|---|
| **Starter** | Starter 1 ⛓ Starter 1, Starter 2 ⛓ Starter 2 usw. Es zählt die Reihenfolge im Team beim Start, also sprecht ab, wer wohin kommt. |
| **Fänge** | Ein Paar pro **Abschnitt von 10 Wellen** (W1–10, W11–20, …). Das entspricht einem Biom. Eure Biome dürfen verschieden sein, PokeRogue verzweigt ja. |
| **Erster Fang zählt** | Weitere Fänge im selben Abschnitt sind „Zweitfänge“. Das Overlay warnt, und automatisches Freilassen dafür lässt sich einschalten. |
| **KO = tot** | Sobald ein Pokémon KO geht, gilt es als tot, auch wenn es später wiederbelebt wird. |
| **Partner stirbt** | Dein verlinktes Pokémon wird freigelassen. |
| **Partner fängt nichts** | Ist der Partner schon über den Abschnitt hinaus und hat dort nichts gefangen, geht dein Fang aus dem Abschnitt auch. |

Jede Regel könnt ihr auf der Website unter **Regeln** mit dem Raum-Passwort an- und ausschalten.

### Wann wird freigelassen?
Freigelassen wird nur in ruhigen Momenten: wenn ihr im Kampf am Zug seid oder im Belohnungs-Bildschirm.
**Pokémon, die gerade kämpfen, werden nicht angefasst.** Dann steht im Overlay „Wechsle X aus“. Sobald es auf der Bank ist, wird es freigelassen.
Ist es euer letztes Pokémon, wird nichts gelöscht. Das Overlay sagt dann, dass der Run laut Regeln vorbei ist.

---

## Einrichtung (ca. 10 Minuten, einmalig)

### 1. Server kostenlos online stellen (Render)
Das macht **einer** von euch.

1. Kostenlosen Account auf **github.com** anlegen und ein neues Repository erstellen, z. B. `pokerogue-soullink`.
2. Alle Dateien aus diesem Ordner hochladen: auf GitHub *Add file → Upload files*, alles reinziehen und *Commit*.
3. Auf **render.com** mit GitHub anmelden, dann *New → Web Service* und euer Repository auswählen.
4. Einstellungen:
   - **Runtime:** Node
   - **Build Command:** `echo ok`
   - **Start Command:** `node server.js`
   - **Instance Type:** Free
5. *Create Web Service*. Nach 1–2 Minuten bekommt ihr eine Adresse wie `https://pokerogue-soullink.onrender.com`. Das ist **eure Website**.

> Hinweis zum Gratis-Plan: Render legt den Server nach ca. 15 Minuten ohne Nutzung schlafen. Der erste Sync danach dauert bis zu einer Minute, der Punkt im Overlay ist so lange gelb.
> Beim Aufwachen gehen Feed und frühere Runs verloren. **Die laufenden Runs nicht**, die schickt das Script automatisch neu.
> Wer das dauerhaft will, hängt bei Render eine Disk an (kostet etwas) und setzt die Umgebungsvariable `DATA_FILE=/var/data/rooms.json`.

### 2. Script installieren (**beide**)
1. Einen Chrome-basierten Browser nehmen (Chrome, Edge, Brave oder Opera) und dort **Tampermonkey** aus dem Web Store installieren.
2. In Chrome unter `chrome://extensions` oben rechts den **Entwicklermodus** einschalten. Bei Tampermonkey unter *Details* zusätzlich „Nutzerskripts zulassen“ aktivieren, falls es angezeigt wird.
3. Eure Website öffnen und auf **Script installieren** klicken. Tampermonkey fragt nach, dann *Installieren*. Die Server-Adresse ist schon drin.

### 3. Verbinden (**beide**)
1. `pokerogue.net` öffnen bzw. neu laden (F5).
2. Oben rechts erscheint das **Soul Link**-Fenster. Dort eintragen:
   - **Raum-Name:** bei beiden gleich, z. B. `gianluca-und-max`
   - **Dein Name:** unterschiedlich
   - **Raum-Passwort:** bei beiden gleich. Wer zuerst verbindet, legt es fest.
3. *Speichern & verbinden*. Ein grüner Punkt heißt verbunden.
4. Den Live-Tracker findet ihr unter `https://eure-adresse/r/gianluca-und-max`. Der Link steht auch im Overlay.

### 4. Spielen
Beide starten einen neuen Classic-Run und wählen die Starter in der abgesprochenen Reihenfolge. Den Rest macht das Tool.

---

## Gut zu wissen
- **Spiel-Updates:** PokeRogue wird oft aktualisiert. Das Script greift direkt auf Spieldaten zu. Wenn nach einem Update „Spiel nicht erkannt“ im Overlay steht oder nichts mehr eingetragen wird, schickt mir die Fehlermeldung aus der Konsole (F12), dann passe ich es an.
- **Gleicher Browser:** Das Script merkt sich Tote und Freigelassene im Browser. Wechselt während eines Runs nicht den Browser oder PC.
- **Fusionen (DNA-Keil):** Das „verschwundene“ Pokémon zählt als weg. Dadurch wird auch sein Partner freigelassen. Wer das nicht will, schaltet die Regel „Partner lässt frei“ aus.
- **Neuer Run:** Wird automatisch erkannt. Der alte Run landet unter „Frühere Runs“.
- **Firefox** wird nicht unterstützt (Tampermonkey kapselt dort Seiten-Skripte anders).

## Lokal testen
```bash
node server.js          # http://localhost:3000
```
Dann im Overlay `http://localhost:3000` als Server eintragen.

## Dateien
| Datei | Zweck |
|---|---|
| `server.js` | Server und Soul-Link-Logik, ohne Abhängigkeiten |
| `public/index.html` | Live-Tracker-Website |
| `public/soullink.user.js` | Tampermonkey-Script fürs Spiel |
| `render.yaml` | Optional: Render-Blueprint für „New → Blueprint“ |
