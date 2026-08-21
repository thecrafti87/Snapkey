# Kaiman — Stufe 0

Der Kern eines eigenen Übertragungsprotokolls: Rahmenformat, Zerlegung in
Blöcke, Fortsetzen nach Abbruch, Handschlag und Verschlüsselung. **Ohne Netz** —
was die Bytes trägt, kommt in Stufe 1 dazu.

Arbeitsname. Das Ding heißt so, weil ein Kaiman ein kleines Krokodil ist und die
Herkunft des Symbols behalten sollte, ohne wieder „croc" zu heißen.

```bash
npm test              # 83 Prüfungen, unter einer Sekunde, ohne Netz
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

## Ehrlich gesagt: kein mDNS

Die Geräteschau ist ein **eigener** Rundruf auf einer eigenen Multicast-Gruppe
(`src/net/discovery.js`) — bewusst **kein** mDNS/Bonjour. Das spart mehrere
hundert Zeilen für ein Drahtformat, das hier niemand braucht. Der Preis:
fremde Programme sehen die Geräte nicht, und `kaiman` sieht umgekehrt auch
keine Geräte, die nur mDNS sprechen. Wer wirklich in die Netzwerk-Norm
integrieren will, tauscht dafür genau diese eine Datei.
