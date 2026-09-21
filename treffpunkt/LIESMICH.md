# Der Treffpunkt auf dem NAS

Ein kleiner Vermittlungsdienst. Zwei Geräte, die sich sonst nicht erreichen —
verschiedene Netze, unterwegs, hinter fremden Routern — melden sich hier unter
ihrer Anschrift und werden zusammengeschaltet.

**Er liest nichts mit.** Die Verschlüsselung gilt von Gerät zu Gerät, auch über
ihn hinweg. Er sieht aber sehr wohl, **wer wann mit wem** verbunden wird. Und
wenn keine der beiden Seiten von außen erreichbar ist, laufen die Daten durch
seine Leitung — das kostet die Bandbreite des NAS, gleich wie groß die Datei
ist.

## Einrichten

```bash
cd treffpunkt
cp .env.beispiel .env
nano .env                    # Passwort eintragen
docker compose up -d
docker compose logs -f
```

Erwartete Ausgabe:

```
Treffpunkt hört auf Port 41997 (mit Passwort)
Bereit. Strg+C beendet.
```

Steht dort **kein** „(mit Passwort)", hat die `.env` nicht gegriffen — dann
kann jeder, der den Dienst erreicht, jede Anschrift belegen.

## Von außen erreichbar machen

Der Container allein genügt nicht: Der Router muss den Port durchlassen.

**IPv6** ist bei den meisten Anschlüssen der verlässlichere Weg. In der
Fritz!Box unter *Internet → Freigaben → Portfreigaben* eine Freigabe für das
NAS auf Port `41997` (TCP) anlegen.

**IPv4** braucht eine eigene öffentliche Adresse. Viele Anschlüsse teilen sich
heute eine (CGNAT) — dann gibt es keinen eigenen Port zum Weiterleiten.
Prüfen lässt sich das von einem Rechner im selben Netz:

```bash
snapkey router
```

Deshalb läuft der Container mit `network_mode: host`: Dockers übliche Brücke
spricht nur IPv4, solange man sie nicht eigens umbaut. Im Wirtsnetz lauscht der
Dienst auf beiden Familien gleichzeitig.

## In SNAPKEY eintragen

Auf **beiden** Geräten unter *Einstellungen → Treffpunkt*:

| Feld | Wert |
|---|---|
| Adresse | der Name oder die Adresse des NAS von außen |
| Port | `41997` |
| Passwort | dasselbe wie in der `.env` |

Danach findet SNAPKEY eine Gegenstelle auch dann, wenn sie nicht im selben Netz
ist. Im eigenen Netz wird weiterhin zuerst direkt gesucht — der Treffpunkt
kommt nur zum Zug, wenn das nicht klappt.

## Erst allein probieren

Bevor jemand Fremdes daneben sitzt und wartet: mit dem eigenen Notebook testen,
**WLAN aus, Mobilfunk an**. Dann ist es wirklich ein fremdes Netz, und
Erreichbarkeit und Passwort lassen sich klären, ohne dass es peinlich wird.

## Betrieb

```bash
docker compose logs -f        # zusehen
docker compose restart        # neu starten
docker compose down           # beenden
docker compose up -d --build  # nach einem Update des Quellcodes
```

Der Container läuft schreibgeschützt und ohne Sonderrechte — der Treffpunkt
speichert nichts, er hält Verbindungen im Arbeitsspeicher und vergisst sie beim
Auflegen. Es gibt deshalb auch nichts zu sichern.

Die Protokolle sind auf 3 × 10 MB begrenzt; ohne das läuft auf einem NAS
irgendwann die Platte voll.

## Wenn es nicht geht

| Bild | Wahrscheinliche Ursache |
|---|---|
| „Im eigenen Netz nicht gefunden — kein Treffpunkt eingerichtet" | Adresse/Port fehlen in den Einstellungen |
| „Passwort abgelehnt" im Protokoll | die beiden Seiten haben verschiedene Passwörter |
| Nichts im Protokoll, obwohl gesendet wird | der Router lässt den Port nicht durch |
| Verbindung nur von innen | Freigabe fehlt oder der Anschluss hat keine eigene IPv4 |

Ob der Dienst überhaupt lauscht, zeigt `docker compose ps` — dort steht bei
einem gesunden Container `healthy`.
