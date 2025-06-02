import React, { useState, useRef, useEffect } from 'react';
import { StyleSheet, View, ActivityIndicator, Alert, ToastAndroid, Platform } from 'react-native';
import { WebView } from 'react-native-webview';
import * as FileSystem from 'expo-file-system';
import * as MediaLibrary from 'expo-media-library';
import { Stack, useRouter } from 'expo-router';
import { useColorScheme } from '@/hooks/useColorScheme';
import { Colors } from '@/constants/Colors';

// Dossier où les images téléchargées seront stockées
const DOWNLOADS_DIRECTORY = `${FileSystem.documentDirectory}downloads/`;

export default function WebViewScreen() {
  const [isLoading, setIsLoading] = useState(true);
  const [mediaPermission, setMediaPermission] = useState(false);
  const webViewRef = useRef<WebView>(null);
  const colorScheme = useColorScheme();
  const router = useRouter();

  // 1. Demander la permission d'accéder à la galerie
  useEffect(() => {
    (async () => {
      const { status } = await MediaLibrary.requestPermissionsAsync();
      setMediaPermission(status === 'granted');
      console.log('Permission MediaLibrary:', status);
    })();
  }, []);

  // 2. Créer le dossier de téléchargements s'il n'existe pas
  useEffect(() => {
    async function ensureDownloadsFolder() {
      try {
        const dirInfo = await FileSystem.getInfoAsync(DOWNLOADS_DIRECTORY);
        if (!dirInfo.exists) {
          await FileSystem.makeDirectoryAsync(DOWNLOADS_DIRECTORY, { 
            intermediates: true 
          });
          console.log('Dossier de téléchargements créé:', DOWNLOADS_DIRECTORY);
        }
      } catch (error) {
        console.error("Erreur lors de la création du dossier de téléchargements:", error);
      }
    }
    ensureDownloadsFolder();
  }, []);

  // 3. Fonction pour télécharger et enregistrer un média (image ou vidéo)
  const downloadAndSaveMedia = async (mediaUrl: string, mimeType: string = '') => {
    try {
      console.log('Début du téléchargement:', mediaUrl);
      console.log('Type MIME:', mimeType);

      // Déterminer si c'est une image ou une vidéo en fonction du mimeType ou de l'URL
      let isVideo = false;
      if (mimeType) {
        isVideo = mimeType.startsWith('video/');
      }

      // Déterminer l'extension du fichier
      let fileExtension = 'jpg'; // Extension par défaut pour les images

      if (mediaUrl.includes('.')) {
        const urlParts = mediaUrl.split('.');
        const potentialExt = urlParts[urlParts.length - 1].split(/[?#]/)[0].toLowerCase();

        // Extensions d'images
        const imageExtensions = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'];
        // Extensions de vidéos
        const videoExtensions = ['mp4', 'mov', 'avi', 'mkv', 'webm', '3gp', 'flv'];

        if (imageExtensions.includes(potentialExt)) {
          fileExtension = potentialExt;
          isVideo = false;
        } else if (videoExtensions.includes(potentialExt)) {
          fileExtension = potentialExt;
          isVideo = true;
        }
      } else if (mimeType) {
        // Utiliser le mimeType pour déterminer l'extension
        if (mimeType.includes('jpeg') || mimeType.includes('jpg')) fileExtension = 'jpg';
        else if (mimeType.includes('png')) fileExtension = 'png';
        else if (mimeType.includes('gif')) fileExtension = 'gif';
        else if (mimeType.includes('webp')) fileExtension = 'webp';
        else if (mimeType.includes('mp4')) fileExtension = 'mp4';
        else if (mimeType.includes('webm')) fileExtension = 'webm';
        else if (mimeType.includes('mov')) fileExtension = 'mov';
        else if (mimeType.includes('avi')) fileExtension = 'avi';
      }

      // Générer un nom de fichier unique avec l'extension correcte
      const prefix = isVideo ? 'video' : 'image';
      const uniqueFilename = `${prefix}_${Date.now()}.${fileExtension}`;
      const fileUri = `${DOWNLOADS_DIRECTORY}${uniqueFilename}`;

      // Télécharger le média
      console.log('Téléchargement vers:', fileUri);

      // Si l'URL est en base64 (data:…), on l’écrit directement
      if (mediaUrl.startsWith('data:')) {
        // On récupère juste la partie base64 après la virgule
        const [, base64Data] = mediaUrl.split(',');
        await FileSystem.writeAsStringAsync(fileUri, base64Data, { encoding: FileSystem.EncodingType.Base64 });
        console.log('Ecriture base64 terminée:', fileUri);
      } else {
        // URL HTTP(S), on télécharge normalement
        const downloadResult = await FileSystem.downloadAsync(mediaUrl, fileUri);
        console.log('Résultat téléchargement:', JSON.stringify(downloadResult));
        if (downloadResult.status !== 200) {
          Alert.alert('Erreur', `Téléchargement échoué avec le statut ${downloadResult.status}`);
          return { success: false };
        }
      }

      // Afficher une confirmation
      const mediaType = isVideo ? 'Vidéo' : 'Image';
      if (Platform.OS === 'android') {
        ToastAndroid.show(`${mediaType} téléchargé(e) avec succès`, ToastAndroid.LONG);
      } else {
        Alert.alert(
          `${mediaType} téléchargé(e)`,
          `Le/La ${mediaType.toLowerCase()} a été enregistré(e) dans l'application. Vous pouvez la voir dans l'onglet "Téléchargements".`,
          [{ text: 'OK', style: 'default' }]
        );
      }

      return { success: true, fileUri, isVideo, fileName: uniqueFilename };
    } catch (error) {
      console.error('Erreur lors du téléchargement:', error);
      Alert.alert('Erreur', `Impossible de télécharger le média: ${error instanceof Error ? error.message : 'Erreur inconnue'}`);
      return { success: false };
    }
  };

  // 4. JavaScript à injecter dans la WebView pour intercepter plusieurs blobs
  //    - On intercepte les clics sur <a href="blob:…">
  //    - Pour chaque blob, on fait fetch → blob → FileReader(base64), on ajoute l'objet { url, mimeType } à window._blobQueue
  //    - Après 500 ms sans nouveau blob, on transmet tout le tableau à React Native en un seul message { type: 'batchDownload', items: [...] }
  const injectedJavaScript = `
    (function() {
      // Tableau global dans la page Web pour stocker temporairement les blobs
      window._blobQueue = [];

      // Timer pour détecter la fin d'une série de blobs
      let _batchTimer = null;

      // Fonction qui, une fois appelée, envoie le conteneur complet à React Native
      function flushBlobQueue() {
        if (window._blobQueue.length === 0) return;
        window.ReactNativeWebView.postMessage(JSON.stringify({
          type: 'batchDownload',
          items: window._blobQueue
        }));
        // On vide le tableau pour la prochaine série
        window._blobQueue = [];
      }

      // Pour chaque nouveau blob détecté, on remet le timer à zéro
      function scheduleFlush() {
        if (_batchTimer) clearTimeout(_batchTimer);
        _batchTimer = setTimeout(function() {
          flushBlobQueue();
          _batchTimer = null;
        }, 500); // 500 ms après le dernier blob, on envoie
      }

      // Fonction pour traiter un lien <a href="blob:…">
      function handleBlobLink(blobUrl) {
        fetch(blobUrl)
          .then(response => response.blob())
          .then(blob => {
            const reader = new FileReader();
            reader.onloadend = function() {
              const base64data = reader.result; // data:xxx;base64,AAAA…
              const isVideo = blob.type.startsWith('video/');
              // On ajoute l'entrée au tableau
              window._blobQueue.push({
                url: base64data,
                mimeType: blob.type || (isVideo ? 'video/mp4' : 'image/jpeg')
              });
              scheduleFlush();
            };
            reader.readAsDataURL(blob);
          })
          .catch(err => {
            console.error('Erreur de conversion blob en base64:', err);
          });
      }

      // On écoute tous les clics sur la page pour intercepter les <a href="blob:…">
      document.addEventListener('click', function(e) {
        const el = e.target.closest('a');
        if (el && typeof el.href === 'string' && el.href.startsWith('blob:')) {
          e.preventDefault();
          handleBlobLink(el.href);
        }
      });

      // Éventuellement, si la page déclenche d'autres manières (fetch automatique),
      // on pourrait aussi surcharger window.fetch ou XMLHttpRequest. Mais pour l'instant,
      // on se concentre sur le clic sur lien <a href="blob:..."> comme point d'entrée.
    })();
  `;

  // 5. Handler pour recevoir le “batchDownload” et traiter chaque media
  const handleOnMessage = async (event: any) => {
    try {
      const data = JSON.parse(event.nativeEvent.data);
      console.log('Message reçu de la WebView:', data.type);

      if (data.type === 'error') {
        console.error('Erreur dans WebView:', data.message);
        Alert.alert('Erreur', data.message);
        return;
      }

      if (data.type === 'batchDownload' && Array.isArray(data.items)) {
        console.log(`Réception de ${data.items.length} blobs en batch.`);
        // Pour chaque entrée, on utilise downloadAndSaveMedia (qui gère base64 ou URL normal)
        for (const item of data.items) {
          const mediaUrl: string = item.url;
          const mimeType: string = item.mimeType || '';
          await downloadAndSaveMedia(mediaUrl, mimeType);
        }
      }
    } catch (error) {
      console.error('Erreur lors du traitement du message:', error);
      Alert.alert('Erreur', `Erreur lors du traitement: ${error instanceof Error ? error.message : 'Erreur inconnue'}`);
    }
  };

  return (
    <View style={styles.container}>
      <Stack.Screen
        options={{
          title: 'Ryvie Web',
          headerShown: true,
        }}
      />
      {isLoading && (
        <ActivityIndicator
          style={styles.loadingIndicator}
          size="large"
          color={Colors[colorScheme ?? 'light'].tint}
        />
      )}
      <WebView
        ref={webViewRef}
        source={{ uri: 'http://ryvie.local:8080/' }}
        style={styles.webView}
        onLoadStart={() => setIsLoading(true)}
        onLoadEnd={() => setIsLoading(false)}
        javaScriptEnabled={true}
        domStorageEnabled={true}
        allowFileAccess={true}
        allowFileDownload={true}
        allowUniversalAccessFromFileURLs={true}
        startInLoadingState={true}
        originWhitelist={['*']}
        injectedJavaScript={injectedJavaScript}
        onMessage={handleOnMessage}
        onShouldStartLoadWithRequest={(request) => {
          // On garde un comportement standard pour les URLs classiques
          // (ni interception ni modification) 
          return true;
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
  },
  webView: {
    flex: 1,
  },
  loadingIndicator: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
