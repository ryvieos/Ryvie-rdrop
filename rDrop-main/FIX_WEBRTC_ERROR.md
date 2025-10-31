# Fix: Erreur WebRTC "Called in wrong state: stable"

## Problème identifié

L'application rDrop générait l'erreur suivante lors de l'envoi de fichiers :
```
InvalidStateError: Failed to execute 'setRemoteDescription' on 'RTCPeerConnection': 
Failed to set remote answer sdp: Called in wrong state: stable
```

De plus, le canal DataChannel ne s'ouvrait jamais, empêchant le transfert de fichiers.

## Causes identifiées

1. **Négociation WebRTC défaillante** : Plusieurs messages SDP "answer" étaient reçus alors que la connexion était déjà stable
2. **Configuration NGINX incomplète** : Headers WebSocket manquants ou mal configurés
3. **Absence de logs de débogage** : Difficile d'identifier où la connexion échouait

## Solutions appliquées

### 1. Vérification de l'état de signalisation (network.js)

Ajout de vérifications pour s'assurer que les messages SDP sont traités uniquement dans les états appropriés :

- **Pour les "offer"** : acceptés uniquement en état `stable` ou `have-local-offer`
- **Pour les "answer"** : acceptés uniquement en état `have-local-offer`
- Les messages SDP inappropriés sont maintenant ignorés avec un warning dans la console

### 2. Protection contre les multiples connexions (network.js)

- Vérification du rôle (caller/callee) avant de recréer une connexion
- Protection contre la création multiple de canaux DataChannel
- Fermeture propre de l'ancienne connexion si le rôle change

### 3. Logs de débogage détaillés (network.js)

Ajout de logs complets pour suivre le cycle de vie WebRTC :
- Création de connexion et de canal
- Réception et envoi de messages SDP
- Changements d'état de la connexion
- Ouverture/fermeture du canal DataChannel

### 4. Configuration NGINX améliorée (default.conf)

Correction de la configuration proxy pour les WebSockets :
- `proxy_http_version 1.1` : Force HTTP/1.1 requis pour WebSocket
- `proxy_set_header Upgrade $http_upgrade` : Permet l'upgrade de connexion
- `proxy_set_header Connection "upgrade"` : Indique une connexion upgrade
- `proxy_set_header Host $host` : Préserve le hostname original
- `proxy_set_header X-Real-IP $remote_addr` : Transmet l'IP réelle du client
- `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for` : Chaîne des proxies
- `proxy_set_header X-Forwarded-Proto $scheme` : Indique le protocole (http/https)
- `proxy_read_timeout 86400` : Timeout de 24h pour les connexions longues

### 5. Gestion des erreurs

- Catch pour les erreurs d'ajout de candidats ICE
- Gestion des erreurs de canal DataChannel
- Logs d'erreur explicites

## Test de la solution

1. **Rafraîchir le navigateur** avec un cache clear (Ctrl+Shift+R ou Cmd+Shift+R)
2. Ouvrir la console développeur (F12)
3. Tenter d'envoyer un fichier à un autre peer
4. Vérifier les logs dans la console :
   - `RTC: _connect called for [peerId] as caller/callee`
   - `RTC: Creating data channel as caller for [peerId]`
   - `RTC: Creating offer for [peerId]`
   - `RTC: Received answer from [peerId] in state: have-local-offer`
   - `RTC: channel opened with [peerId]`
   - `RTC: channel state: open`

## Fichiers modifiés

1. **`/data/apps/Ryvie-rdrop/rDrop-main/client/scripts/network.js`**
   - Ajout de vérifications d'état de signalisation
   - Protection contre les multiples connexions
   - Logs de débogage détaillés

2. **`/data/apps/Ryvie-rdrop/rDrop-main/docker/nginx/default.conf`**
   - Configuration WebSocket complète pour HTTP (port 80)
   - Configuration WebSocket complète pour HTTPS (port 443)

## Actions effectuées

- ✅ Modification du fichier `network.js`
- ✅ Modification du fichier `default.conf`
- ✅ Redémarrage du conteneur `app-rdrop-nginx`

## Notes importantes

- Le conteneur nginx a été redémarré pour appliquer les changements de configuration
- Les modifications JavaScript sont immédiatement disponibles (volume monté)
- **Vous DEVEZ rafraîchir votre navigateur avec Ctrl+Shift+R** pour charger le nouveau JavaScript
- La solution suit les bonnes pratiques WebRTC et WebSocket

---

## Problème supplémentaire : Connexions mobiles échouent

### Symptômes
- ✅ Transferts entre ordinateurs fonctionnent
- ❌ Transferts vers/depuis téléphones échouent
- Logs : `ICE Gathering disconnected` puis `state changed: failed`

### Cause
Les réseaux mobiles utilisent souvent des NAT restrictifs qui empêchent les connexions WebRTC directes. Un serveur TURN est nécessaire pour relayer le trafic.

### Solution temporaire appliquée
Ajout de serveurs TURN publics gratuits (OpenRelay) dans la configuration WebRTC.

**⚠️ Limitations des serveurs publics** :
- Bande passante limitée
- Pas de garantie de disponibilité
- Peut être lent pour les gros fichiers

### Solution de production
Pour une utilisation en production, vous devez configurer votre propre serveur TURN.

📖 **Voir le guide complet** : [`TURN_SERVER_SETUP.md`](./TURN_SERVER_SETUP.md)

**Options** :
1. **Auto-hébergé (Coturn)** : ~5-10€/mois, contrôle total
2. **Service managé** : ~20-50€/mois, sans maintenance

### Vérifier que TURN fonctionne
Après rafraîchissement, vérifiez dans la console :
```
RTC: ICE candidate (HOST) for [peerId]
RTC: ICE candidate (STUN) for [peerId]
RTC: ICE candidate (TURN) for [peerId]  ← Doit apparaître
RTC: Successfully connected to [peerId]
```

Si vous voyez des candidats TURN, la connexion devrait fonctionner même avec les téléphones.
