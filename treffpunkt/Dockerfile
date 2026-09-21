# =====================================================================
# Der Treffpunkt als Container.
#
# Hier laueft NUR die Vermittlung - kein Fenster, kein Electron, keine
# Schluessel. Der Treffpunkt hat keine eigene Anschrift und braucht
# nichts zu speichern: er haelt Verbindungen im Arbeitsspeicher und
# vergisst sie beim Auflegen. Deshalb kommt hier auch nichts von app/
# hinein und kein node_modules - der Kern hat keine Fremdpakete.
#
# Was das Bild klein und langweilig haelt, ist Absicht: je weniger drin
# ist, desto weniger kann angegriffen werden. Das Ergebnis sind ein paar
# Dutzend Kilobyte eigener Code auf einem Alpine-Node.
# =====================================================================

FROM node:22-alpine

# Nicht als root. Das Bild "node" bringt den Benutzer schon mit.
WORKDIR /opt/snapkey

# Nur, was die Vermittlung wirklich braucht. package.json kommt mit,
# damit require-Pfade und die Fassungsnummer stimmen.
COPY package.json ./
COPY src ./src
COPY bin ./bin

USER node

# Der voreingestellte Port. Wird er im Compose geaendert, gehoert er
# hier nicht angepasst - EXPOSE ist nur eine Notiz, keine Regel.
EXPOSE 41997

# Kein Shell-Zwischenschritt: so kommt SIGTERM unmittelbar beim Node an,
# und der Treffpunkt kann sich ordentlich verabschieden.
ENTRYPOINT ["node", "bin/snapkey.js", "treffpunkt"]
