# ioBroker.ecoflow-powercontrol

Generische Solar-Wechselrichterregelung mit optionaler EcoFlow-MQTT-Anbindung.

Dieser Adapter regelt die Einspeiseleistung von Wechselrichtern auf Basis eines Smart-Meter-Signals (Nulleinspeisung / Eigenverbrauchsoptimierung). Er unterstützt **jeden Wechselrichter**, der ioBroker-States zum Lesen (Ausgangsleistung, Batterie-SOC, PV-Leistung) und Schreiben (Sollwert) besitzt. Die EcoFlow-MQTT-Anbindung ist ein optionales Modul.

---

## Unterstützte Geräte und Update auf 0.1.49

Die integrierte EcoFlow-Anbindung unterstützt den klassischen **PowerStream**, nicht die neue **STREAM-Serie (STREAM Pro/Ultra/AC Pro)**. Ein erfolgreicher Verbindungstest bestätigt Anmeldung und Brokerzugang, nicht die Unterstützung des Geräteprotokolls. Generische Wechselrichter werden über ihre konfigurierten ioBroker-States in Watt gesteuert.

Beim ersten Start werden alte Admin-Feldnamen automatisch übernommen. Passwort und eingefügter Importtext werden in geschützte, verschlüsselte Konfigurationsfelder migriert; dabei kann die Instanz neu starten. Vor dem Update die Instanzeinstellungen sichern. Das explizite Abschalten von EcoFlow MQTT wird jetzt respektiert. Nach einem Altskriptimport die Zuordnung und Werte prüfen, bevor die Regelung eingeschaltet wird. Bereits vorhandene ältere Logdateien können noch Zugangsdaten enthalten; diese nicht ungeprüft veröffentlichen.

## Installation

### Über GitHub-URL (empfohlen)

1. ioBroker Admin öffnen → **Adapter** → **+ Adapter installieren**
2. Tab **"Eigene URL"** auswählen
3. URL eingeben: `https://github.com/Waly-de/ioBroker.ecoflow-powercontrol`
4. **Installieren** klicken

---

## Konfiguration

Die Konfiguration erfolgt ausschließlich im Admin-Bereich des Adapters (4 Tabs).

### Tab 1: Wechselrichter

Für jeden Wechselrichter werden State-IDs konfiguriert:

| Feld | Beschreibung |
|------|-------------|
| **ID / Seriennr.** | Eindeutige Kennung (bei EcoFlow: Seriennummer des PowerStream) |
| **Typ** | `generic` oder `ecoflow` |
| **Max. Leistung (W)** | Maximale Ausgangsleistung |
| **Ausgangs-State** | ioBroker State-ID für die aktuelle Ausgangsleistung (Lesen) |
| **Sollwert-State** | ioBroker State-ID für den Leistungs-Sollwert (Schreiben) |
| **Akku-SOC-State** | Batterie-Ladestand in % |
| **PV-Leistungs-State** | PV-Eingangsleistung in W |
| **Prioritäts-State** | Für Batterie-Prioritätsmodus (0/1) |

**EcoFlow-Typ:** Der Wert wird automatisch ×10 umgerechnet (EcoFlow-Protokoll). Für den klassischen PowerStream werden leere Messwertfelder automatisch zugeordnet; ohne expliziten PV-State werden PV1 und PV2 addiert. Nach der ersten MQTT-Verbindung werden States unter `ecoflow-powercontrol.0.ecoflow.*` angelegt – diese können direkt als State-IDs eingetragen werden.

**Typische EcoFlow PowerStream State-Pfade** (nach MQTT-Verbindung):
- Ausgang: `ecoflow-powercontrol.0.ecoflow.app_device_property_SERIENNR.data.InverterHeartbeat.invOutputWatts`
- PV: `ecoflow-powercontrol.0.ecoflow.app_device_property_SERIENNR.data.InverterHeartbeat.pv1InputWatts` (+ pv2InputWatts addieren)
- Akku-SOC: `ecoflow-powercontrol.0.ecoflow.app_device_property_SERIENNR.data.InverterHeartbeat.batSoc`

#### Batterie-Logik

- **Bat. voll ab (%)**: Ab diesem SOC wird auf Volleinspeisung oder Batterie-Priorität umgeschaltet
- **Bat. leer ab (%)**: Unterhalb dieses SOC wird normale Regelung wieder aufgenommen
- **Niedrig-Limit**: Bei sehr niedrigem Akku wird die Maximalleistung begrenzt
- **Einspeisung wenn Regelung aus**: `0` = Minimum, `-2` = Prioritätsmodus, Watt-Wert = fester Sollwert

#### Zusätzliche Quellen
Andere Einspeiser (z.B. PV-Anlage am Hausnetz ohne Wechselrichter), die in der Regelung berücksichtigt werden sollen.

#### Überschussladung
Schaltet einen Verbraucher (Heizstab, Wärmepumpe) bei Einspeisung-Überschuss ein und regelt dessen Leistung.

---

### Tab 2: EcoFlow MQTT

Wenn EcoFlow-Geräte vorhanden sind:
- **E-Mail / Passwort**: EcoFlow App-Zugangsdaten (werden verschlüsselt gespeichert)
- **Geräteliste**: Seriennummer, Typ und Abo-Flag für jedes Gerät

Der Adapter verbindet sich mit dem EcoFlow MQTT-Broker und erstellt alle Gerätedaten automatisch als ioBroker-States.

---

### Tab 3: Regelung

| Parameter | Beschreibung |
|-----------|-------------|
| **Smart-Meter State-ID** | State mit aktuellem Netzbezug (W, positiv = Bezug) |
| **Timeout** | Nach dieser Zeit ohne Smart-Meter-Daten wird der Fallback-Wert genutzt |
| **Regelintervall** | Wie oft die Regelschleife läuft (Sekunden) |
| **Basis-Offset** | Ziel-Netzbezug (positiv = leichter Bezug, verhindert Einspeisung ins Netz) |
| **Zeitfenster Minimalwert** | Minutenfenster für den History-Minimalwert (verhindert Überschwingen) |
| **History-Adapter** | `history`, `influxdb` oder `sql` – der Adapter konfiguriert die Aufzeichnung automatisch |

---

### Tab 4: Info / Debug

- **Debug-Logging**: Gibt alle MQTT-Nachrichten im Log aus
- **Meldungslog**: Detaillierte Regelungs-Meldungen

---

## Adapter-States

```
ecoflow-powercontrol.0.
├── info.connection              # MQTT verbunden (bool)
├── regulation.
│   ├── enabled                  # Regelung ein/aus (bool, schreibbar)
│   ├── gridPower                # Aktueller Netzbezug (W)
│   ├── realPower                # Berechneter Hausverbrauch (W)
│   ├── totalPV                  # Gesamt-PV-Leistung (W)
│   ├── excessPower              # Überschuss für Zusatzladung (W)
│   ├── lowestValue              # Minimum im Messfenster (W)
│   ├── additionalPowerSum       # Summe Zusatzeinspeiser (W)
│   └── additionalPVSum          # Summe Zusatz-PV (W)
├── inverters.
│   └── [id].
│       ├── currentOutput        # Aktueller Ausgang (W)
│       ├── batterySOC           # Akku-Ladestand (%)
│       ├── pvPower              # PV-Eingang (W)
│       └── targetOutput         # Letzter Sollwert (W)
└── ecoflow.                     # Nur wenn EcoFlow aktiv
    └── [topic].                 # Alle MQTT-Daten, dynamisch erstellt
```

---

## Abhängigkeiten

```json
{
  "@iobroker/adapter-core": "^3.1.6",
  "axios": "^1.7.2",
  "mqtt": "^5.7.3",
  "protobufjs": "^7.3.2"
}
```

---

## Lizenz

MIT License – siehe [LICENSE](LICENSE)

## Autor

Markus Walber <markus@walber.de>


## Entwicklung und Prüfung

```sh
npm ci --ignore-scripts
npm run check
npm test
npm run test:integration
```

Die Regressionstests verwenden synthetische Daten und einen lokalen MQTT-Broker auf `127.0.0.1`. Der offizielle ioBroker-Testharness installiert einen separaten Controller in einem temporären Verzeichnis und verwendet eigene lokale Datenbankports. Es werden keine echten EcoFlow-Zugangsdaten oder Geräte benötigt. Der Controller-Test prüft Start/Stopp, synthetische Regelung und manuelles Ausschalten. CI führt diese Prüfungen bei Push und Pull Request aus.

History ist bei Zeitfenster `0` vollständig optional. Bei einer ausbleibenden Historyantwort wird nach fünf Sekunden der aktuelle berechnete Verbrauch verwendet. Ein laufender Regelzyklus wird nicht parallel erneut gestartet; manuelles Ausschalten gewinnt vor weiteren Leistungsbefehlen. Die Leistungsgrenze wird vor der gerätespezifischen Einheitenumrechnung angewendet.

Die Tests ersetzen keine Abnahme mit einer realen EcoFlow-Anlage. Brokerbestätigung ist keine Bestätigung, dass das Gerät den Sollwert tatsächlich umgesetzt hat.
