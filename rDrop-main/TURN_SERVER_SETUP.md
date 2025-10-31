# Configuration serveur TURN pour rDrop

## Problème

Les connexions WebRTC entre ordinateurs et téléphones échouent souvent avec :
- `ICE Gathering disconnected`
- `state changed: failed`

Cela se produit lorsque les peers sont derrière des NAT restrictifs (réseaux mobiles, firewalls d'entreprise, etc.) et ne peuvent pas établir de connexion directe.

## Solution temporaire appliquée

Ajout de serveurs TURN publics gratuits (OpenRelay) :
- `turn:openrelay.metered.ca:80`
- `turn:openrelay.metered.ca:443`
- `turn:openrelay.metered.ca:443?transport=tcp`

**⚠️ ATTENTION** : Ces serveurs publics ont des limitations :
- Bande passante limitée
- Pas de garantie de disponibilité
- Partagés avec d'autres utilisateurs
- Peuvent être lents pour les gros fichiers

## Solution de production recommandée

### Option 1 : Serveur TURN auto-hébergé (Coturn)

**Avantages** :
- Contrôle total
- Pas de limitation de bande passante
- Meilleure performance
- Confidentialité garantie

**Installation sur Ubuntu/Debian** :

```bash
# Installer Coturn
sudo apt update
sudo apt install coturn

# Activer le service
sudo systemctl enable coturn
```

**Configuration `/etc/turnserver.conf`** :

```conf
# Écouter sur toutes les interfaces
listening-ip=0.0.0.0

# Port externe (à ouvrir dans le firewall)
external-ip=VOTRE_IP_PUBLIQUE

# Ports à utiliser
listening-port=3478
tls-listening-port=5349

# Domaine
realm=rdrop.votre-domaine.com

# Authentification
user=rdrop:VOTRE_MOT_DE_PASSE_FORT
lt-cred-mech

# Logs
log-file=/var/log/turnserver.log
verbose

# Limites
max-bps=1000000
```

**Ouvrir les ports dans le firewall** :

```bash
sudo ufw allow 3478/tcp
sudo ufw allow 3478/udp
sudo ufw allow 5349/tcp
sudo ufw allow 5349/udp
sudo ufw allow 49152:65535/udp  # Plage de ports pour le relais
```

**Redémarrer Coturn** :

```bash
sudo systemctl restart coturn
```

**Mettre à jour `network.js`** :

```javascript
RTCPeer.config = {
    'sdpSemantics': 'unified-plan',
    'iceServers': [
        {
            urls: 'stun:stun.l.google.com:19302'
        },
        {
            urls: 'turn:rdrop.votre-domaine.com:3478',
            username: 'rdrop',
            credential: 'VOTRE_MOT_DE_PASSE_FORT'
        },
        {
            urls: 'turns:rdrop.votre-domaine.com:5349',
            username: 'rdrop',
            credential: 'VOTRE_MOT_DE_PASSE_FORT'
        }
    ],
    'iceCandidatePoolSize': 10
}
```

### Option 2 : Service TURN managé

**Services recommandés** :
- **Twilio STUN/TURN** : https://www.twilio.com/stun-turn
- **Xirsys** : https://xirsys.com/
- **Metered.ca** : https://www.metered.ca/turn-server

**Avantages** :
- Pas de maintenance
- Haute disponibilité
- Scalabilité automatique

**Inconvénients** :
- Coût mensuel
- Dépendance à un service tiers

## Test de la configuration

Après avoir configuré TURN, testez avec :

1. **Rafraîchir le navigateur** (Ctrl+Shift+R)
2. **Ouvrir la console** (F12)
3. **Envoyer un fichier depuis le téléphone**
4. **Vérifier les logs** :

```
RTC: ICE candidate (HOST) for [peerId]
RTC: ICE candidate (STUN) for [peerId]
RTC: ICE candidate (TURN) for [peerId]  ← Doit apparaître
RTC: Successfully connected to [peerId]
```

Si vous voyez `ICE candidate (TURN)`, le serveur TURN fonctionne !

## Diagnostic des problèmes

### Tester le serveur TURN

Utilisez l'outil en ligne : https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/

Entrez vos credentials TURN et vérifiez que des candidats `relay` apparaissent.

### Logs Coturn

```bash
sudo tail -f /var/log/turnserver.log
```

### Vérifier les ports ouverts

```bash
sudo netstat -tulpn | grep turnserver
```

## Coût estimé

- **Auto-hébergé (Coturn)** : ~5-10€/mois (VPS basique)
- **Service managé** : ~20-50€/mois selon l'usage
- **Serveurs publics** : Gratuit mais limité

## Sécurité

⚠️ **Important** :
- Changez les credentials par défaut
- Utilisez HTTPS/TLS pour la signalisation
- Limitez l'accès au serveur TURN (whitelist IP si possible)
- Surveillez l'utilisation de bande passante
- Mettez à jour régulièrement Coturn

## Ressources

- [Documentation Coturn](https://github.com/coturn/coturn)
- [WebRTC ICE](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Connectivity)
- [TURN Server Setup Guide](https://www.html5rocks.com/en/tutorials/webrtc/infrastructure/)
