# Kaiman — Stufe 0

Der Kern eines eigenen Übertragungsprotokolls: Rahmenformat, Zerlegung in
Blöcke, Fortsetzen nach Abbruch, Handschlag und Verschlüsselung. **Ohne Netz** —
was die Bytes trägt, kommt in Stufe 1 dazu.

Arbeitsname. Das Ding heißt so, weil ein Kaiman ein kleines Krokodil ist und die
Herkunft des Symbols behalten sollte, ohne wieder „croc" zu heißen.

```bash
npm test              # 130 Prüfungen, unter zwei Sekunden, ohne Netz
node test/vorfuehrung.js   # 39 MB übertragen, abbrechen, fortsetzen
```

Keine Fremdpakete. Alles, was der Kern braucht, ist in Node eingebaut.

## Der Aufbau

| Datei | Wofür |
|---|---|
| `src/core/crypto.js` | X25519, HKDF, AES-256-GCM, SHA-256 — die einzige Stelle, die für den Browser getauscht werden muss |
| `src/core/identity.js` | Schlüsselpaar, Anschrift aus sechs Wörtern, gemerkte Gegenstellen |
| `src/core/frame.js` | Längenvoranstellung, Steuerung als JSON, Blöcke roh |
| `src/core/chunks.js` | Einsammeln, Blockprüfsummen, **was fehlt noch**, Hineinlegen |
| `src/core/handshake.js` | Aus zwei Schlüsselpaaren wird ein Sitzungsschlüssel |
| `src/core/session.js` | Der Ablauf, über einem beliebigen Transport |
| `src/transport/memory.js` | Zwei Endpunkte im Speicher — nur zum Prüfen |

## Wie das Fortsetzen funktioniert

Der Fortsetzungsstand wird **nicht** nebenher mitgeschrieben, sondern aus dem
gelesen, was auf der Platte liegt: jeder Block wird nachgerechnet und mit der
Liste verglichen.

Das ist langsamer als eine Merkdatei — und überlebt dafür alles: Absturz,
Stromausfall, halb geschriebene Blöcke, eine Datei, die jemand zwischendurch
angefasst hat. Eine Merkdatei behauptet, was da sein *sollte*. Die Platte weiß,
was da *ist*.

Der Empfänger sagt dem Sender, was er braucht. Deshalb gibt es keinen
Sonderfall „Wiederaufnahme" im Code — beim zweiten Anlauf fällt die Antwort
einfach kürzer aus:

```
--- Anlauf 1 ---
  abgebrochen nach 15.0 MB
--- Anlauf 2 ---
  geschickt      25.0 MB in 26 Blöcken
  wiederverwendet 14 Blöcke, die schon dalagen
--- Anlauf 3 ---
  geschickt      0.0 MB in 0 Blöcken
```

## Die Anschrift

Beim ersten Start entsteht ein Schlüsselpaar. Der geheime Teil verlässt das
Gerät nie, der öffentliche wird zur Anschrift:

```
kaiman:quark-ferse-topf-platte-zitrone-nebel
```

Sechs Wörter aus der mitgeführten Liste, 50 Bit, abgeleitet aus der Prüfsumme
des öffentlichen Schlüssels. Sie ist eine **Anschrift, kein Geheimnis**: sie
sagt, wen man sucht, nicht dass man es sein darf.

Beim ersten Kontakt wird der volle Schlüssel der Gegenstelle gemerkt. Ab dann
ist jede weitere Verbindung daran gebunden — gleiche Anschrift mit anderem
Schlüssel meldet der Kern als `changed` und hält an, statt selbst zu
entscheiden. Dasselbe Modell wie bei SSH.

## Zur Verschlüsselung — bitte lesen

`handshake.js` enthält eine **selbstgebaute Zusammensetzung**. Sie benutzt
ausschließlich Standardbausteine und folgt einem bekannten Muster (vier
Diffie-Hellman-Rechnungen, gebunden an ein Protokoll der Begegnung — dasselbe
Muster wie Noise KK). Trotzdem ist „aus richtigen Teilen zusammengesetzt" nicht
dasselbe wie „geprüft", und der Unterschied fällt im Betrieb nicht auf, weil es
ja funktioniert.

**Bevor hier Daten fremder Leute durchgehen, wird diese eine Datei gegen eine
geprüfte Noise-Umsetzung getauscht.** Die Schnittstelle ist genau dafür schmal
gehalten: Nachrichten rein, zwei Schlüssel raus. Sonst muss sich nichts ändern.

## Was Stufe 0 schon kann

- Ordner mit Unterordnern übertragen, Struktur bleibt erhalten
- Abbruch überleben und nur den Rest nachholen
- Kaputte Daten erkennen — auch den Fall „richtige Größe, Nullen darin",
  an dem croc scheitert
- Beidseitige Echtheit, eigene Schlüssel je Sitzung und je Richtung
- Leere Dateien, zu lange Dateien, Blöcke in beliebiger Reihenfolge

## Was fehlt

Alles, was mit Netz zu tun hat — das ist Stufe 1 und danach. Und die
Rückstaubehandlung ist erst angelegt: `transport.drain()` wird abgefragt, wenn
der Transport es anbietet, sonst wird alle 16 Blöcke abgegeben. Ein echter
Transport bringt das mit.

# Stufe 1 — Nahweg

Jetzt trägt eine echte TCP-Verbindung die Bytes, und ein Rundruf im eigenen
Netz sagt, wer sonst noch da ist. Aus dem Kern von Stufe 0 wird damit ein
Werkzeug, das man von der Kommandozeile aus benutzen kann — ohne Server, ohne
Konto, ohne dass irgendetwas außerhalb des eigenen Netzes davon erfährt.

```bash
npm install -g .            # oder: node bin/kaiman.js …
kaiman id                   # eigene Anschrift und Ablageort
kaiman peers                # wer ist sonst noch da? (6 Sekunden lauschen)
kaiman listen --neue-annehmen
kaiman send <anschrift-oder-name> ~/Bilder/urlaub
```

## Die vier Befehle

**`kaiman id`** — zeigt die eigene Anschrift, den Fingerabdruck und wo der
Schlüssel liegt.

```bash
$ kaiman id
Anschrift:     kaiman:quark-ferse-topf-platte-zitrone-nebel
Fingerabdruck: 9f2a 6e10 c3b4 0a71
Ablage:        /Users/anna/.kaiman
```

**`kaiman peers`** — lauscht sechs Sekunden auf den Rundruf und zeigt, welche
Geräte im selben Netz geantwortet haben, samt der Frage, ob man mit ihnen
schon gekoppelt ist.

```bash
$ kaiman peers
Suche im Netz (6 s) ...
Name        Anschrift                             Adresse:Port      Gekoppelt
----------  ------------------------------------   ---------------   ---------
Werkstatt   quark-ferse-topf-platte-zitrone-nebel   10.0.0.12:41999   ja
```

**`kaiman listen [--out ORDNER] [--neue-annehmen] [--port N] [--name NAME]`**
— startet einen Knoten, der auf eingehende Übertragungen wartet, und läuft,
bis `Strg+C` ihn sauber beendet. Ohne `--neue-annehmen` kommen nur bereits
gekoppelte Gegenstellen durch.

```bash
$ kaiman listen --out ~/Empfangen --neue-annehmen
Kaiman hört auf kaiman:quark-ferse-topf-platte-zitrone-nebel
Ziel: /Users/anna/Empfangen
Neue Gegenstellen werden angenommen.
Bereit. Strg+C beendet.
```

**`kaiman send <ziel> <pfad...>`** — `<ziel>` ist eine Anschrift oder ein
Gerätename, wie ihn `kaiman peers` zeigt. Sucht kurz danach, schickt dann.

```bash
$ kaiman send Werkstatt ~/Bilder/urlaub
Suche "Werkstatt" (bis 6 s) ...
Gefunden: Werkstatt (10.0.0.12:41999)
  100% - 38.2 MB (Block 39/39)
Geschickt: 39 Block(e), von der Gegenstelle wiederverwendet: 0, vollständig.
```

## Blockwiedererkennung

Bevor ein fehlender Block über die Leitung angefragt wird, schaut der
Empfänger zuerst im eigenen Zielordner nach: vielleicht liegt der Inhalt
schon da, nur unter einem anderen Namen. Erkannt wird das über dieselben
Blockprüfsummen, die auch das Fortsetzen tragen — nicht über Dateinamen
oder Zeitstempel.

**Was erkannt wird:**

- eine **umbenannte** Datei
- eine **verschobene** Datei (auch in einen anderen Unterordner)
- eine **kopierte** Datei, irgendwo im Zielordner
- die **zweite Fassung eines Ordners**, in dem sich nur wenig geändert hat —
  jeder unveränderte Block wird wiedererkannt, nur die echten Änderungen
  gehen über die Leitung

**Was nicht erkannt wird:** ein **Einschub mitten in einer Datei**. Blöcke
liegen an festen 1-MiB-Grenzen *innerhalb* einer Datei; Umbenennen,
Verschieben und Kopieren lassen diese Grenzen unangetastet, ein Einschub
verschiebt aber alles Folgende um einen Versatz, der kein Vielfaches von
1 MiB ist — keine Prüfsumme trifft danach mehr. Das ist eine bewusste
Grenze: ein Rolling Hash fände auch das, kostet aber ein Vielfaches an
Rechenzeit für einen Fall, der beim Übertragen ganzer Ordner selten ist.

Die Suche findet **im Zielordner** statt, bevor die Wunschliste an den
Sender geht — der Sender selbst ändert sich dadurch nicht und weiß von
alldem nichts. Mit `--ohne-wiedererkennung` bei `kaiman listen` entfällt
die Suche vollständig, und es verhält sich wie zuvor: jeder fehlende Block
wird angefragt, ganz gleich, was sonst noch im Zielordner liegt.

```bash
$ kaiman send Werkstatt ~/Bilder/urlaub
...
Geschickt: 0 Block(e), von der Gegenstelle wiederverwendet: 39, vollständig.
```

Beim Empfänger steht dazu, während es passiert:

```
Bekannte Gegenstelle: ...
  39 Block(e) lokal wiederhergestellt (ohne Übertragung)
Empfangen von ...: vollständig (0 Block(e) neu, 0 schon vorhanden)
```

## Ehrlich gesagt: kein mDNS

Die Geräteschau ist ein **eigener** Rundruf auf einer eigenen Multicast-Gruppe
(`src/net/discovery.js`) — bewusst **kein** mDNS/Bonjour. Das spart mehrere
hundert Zeilen für ein Drahtformat, das hier niemand braucht. Der Preis:
fremde Programme sehen die Geräte nicht, und `kaiman` sieht umgekehrt auch
keine Geräte, die nur mDNS sprechen. Wer wirklich in die Netzwerk-Norm
integrieren will, tauscht dafür genau diese eine Datei.

# Stufe 3 — der Treffpunkt

Der Rundruf aus Stufe 1 funktioniert nur, solange beide Geräte im selben Netz
sitzen. Stehen sie hinter zwei verschiedenen Routern — das eine zu Hause, das
andere unterwegs —, findet keins das andere von allein. Dafür gibt es jetzt
den **Treffpunkt**: einen kleinen Vermittlungsdienst, den man selbst irgendwo
laufen lässt (ein NAS, ein kleiner Server, egal was dauerhaft erreichbar ist),
über den sich zwei Geräte unter einer Anschrift finden und die Leitung
zusammenschalten lassen.

```bash
kaiman treffpunkt --port 41997 --pass geheimnis
```

Auf dem empfangenden Gerät meldet sich `kaiman listen` zusätzlich dort an:

```bash
kaiman listen --out ~/Empfangen --neue-annehmen \
  --treffpunkt dxp8800plus-1 --treffpunkt-pass geheimnis
```

Und beim Senden reicht dieselbe Anschrift, dieselben zwei Flaggen:

```bash
kaiman send wal-tanne-nordwind-flotte-kiel-schilf ~/Bilder/urlaub \
  --treffpunkt dxp8800plus-1 --treffpunkt-pass geheimnis
```

`send` sucht dabei **immer zuerst im eigenen Netz** — genau wie bisher — und
geht nur über den Treffpunkt, wenn dort in dieser Zeit niemand gefunden wurde.
Die Ausgabe sagt, welcher der beiden Wege es war:

```
Suche "wal-tanne-nordwind-flotte-kiel-schilf" im eigenen Netz (bis 6 s) ...
Im eigenen Netz nicht gefunden - versuche es über den Treffpunkt dxp8800plus-1:41997 ...
  100% - 38.2 MB (Block 39/39)
Geschickt: 39 Block(e), vollständig.
```

## Was der Treffpunkt sieht — und was nicht

**Er beglaubigt niemanden.** Wer sich dort unter einer fremden Anschrift
anmeldet, erreicht damit höchstens, dass die echte Gegenstelle gerade nicht
erreichbar ist — Daten bekommt er trotzdem nicht: der Handschlag der Sitzung
darüber (`handshake.js`) weist ihn ab, weil der dabei bewiesene Schlüssel
nicht zu dem passt, den die Gegenseite erwartet. Das **Passwort** (`--pass`
beim Treffpunkt, `--treffpunkt-pass` bei `listen`/`send`) ist der Schutz
gegen genau diese Belegung einer Anschrift — nicht gegen Mitlesen. Ohne
Passwort kann sich jeder, der den Treffpunkt erreicht, unter jeder Anschrift
anmelden oder nach jeder suchen.

**Er sieht den Inhalt nicht.** Sobald zwei Seiten zusammengeschaltet sind,
deutet der Treffpunkt kein einziges Byte mehr — er reicht nur noch roh durch,
was ohnehin schon Ende-zu-Ende verschlüsselt ist (derselbe Handschlag wie im
eigenen Netz, siehe „Zur Verschlüsselung" oben). Er **sieht aber sehr wohl**,
wer wann mit wem verbunden wird, und **die Daten laufen tatsächlich durch
seine Leitung** — das kostet seine Bandbreite, ganz gleich wie groß die Datei
ist. Ein Treffpunkt auf einem lahmen Anschluss bremst jede Übertragung über
ihn aus, auch wenn beide Enden selbst schnell wären.

**Deshalb**: Ist eine Gegenstelle ohnehin erreichbar — über ein VPN wie
Tailscale, eine Portfreigabe, dasselbe Rechenzentrum —, ist `--an
<host[:port]>` der bessere Weg. Er verbindet direkt, ohne Suche und ohne
Treffpunkt, ohne dessen Bandbreite zu belasten:

```bash
kaiman send wal-tanne-nordwind-flotte-kiel-schilf ~/Bilder/urlaub --an 100.x.y.z
```

Der Treffpunkt lohnt sich für den Fall, den nichts davon abdeckt: zwei Geräte,
die sich sonst schlicht nicht erreichen.

## Wie eine Vermittlung abläuft

Wer erreichbar sein will, meldet sich mit `here` unter seiner Anschrift an und
wartet. Wer jemanden sucht, schickt `reach` mit derselben Anschrift. Sind
beide da, schickt der Treffpunkt an beide `joined` und schaltet die
Leitungen zusammen — die Anmeldung ist damit verbraucht. Danach meldet sich
der wartende Knoten sofort wieder an, bleibt also nach jeder Übertragung
weiter erreichbar. Eine zweite Anmeldung unter derselben Anschrift verdrängt
eine ältere; wer binnen 30 Sekunden weder `here` noch `reach` sagt, wird
getrennt.
