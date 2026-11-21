# Exkursionskarte Aachen

Gemeinsame Karte für Exkursionen: Schülergruppen laufen durch Aachen, tragen Orte mit Namen, Beschreibung und Fotos ein und ordnen sie farbigen Kategorien zu. So entsteht eine Legende. Die Karte basiert auf OpenStreetMap und zeigt den eigenen Standort per GPS.

## Aufbau

- **Website:** statische Dateien (`index.html`, `app.js`, `style.css`), veröffentlicht über GitHub Pages. Auf dem Handy lässt sie sich über „Zum Startbildschirm hinzufügen“ wie eine App installieren.
- **Daten und Fotos:** Supabase. Die Tabellen sind gesperrt, alle Zugriffe laufen über Datenbankfunktionen, die den Klassencode prüfen. Fotos liegen im öffentlichen Speicher-Bucket `fotos`.

## Einrichtung

1. In `supabase-setup.sql` die Platzhalter `KLASSENCODE_HIER` und `LEHRERCODE_HIER` durch eigene Codes ersetzen und das Skript im Supabase SQL Editor ausführen. Die echten Codes nicht in dieses Repository schreiben.
2. In `config.js` die Project URL und den **publishable key** des Supabase-Projekts eintragen (nie den secret key).
3. In GitHub unter **Settings → Pages** als Quelle „Deploy from a branch“, Branch `main`, Ordner `/ (root)` wählen.

## Rollen

- **Klassencode:** Orte eintragen, eigene Orte bearbeiten und löschen, Kategorien anlegen.
- **Lehrkraft-Code:** zusätzlich alle Orte bearbeiten, Kategorien ändern und löschen, Aufgabenstellung setzen, Liste als CSV herunterladen.

Ein Link mit `?code=…` füllt den Klassencode auf der Anmeldeseite vor.

Kartendaten © OpenStreetMap-Mitwirkende.
