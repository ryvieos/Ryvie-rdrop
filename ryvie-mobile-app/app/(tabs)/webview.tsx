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

  // Demander la permission d'accéder à la galerie
  useEffect(() => {
    (async () => {
      const { status } = await MediaLibrary.requestPermissionsAsync();
      setMediaPermission(status === 'granted');
      console.log('Permission MediaLibrary:', status);
    })();
  }, []);

  // Créer le dossier de téléchargements s'il n'existe pas
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

  // Fonction pour télécharger et enregistrer un média (image ou vidéo)
  // → NE PLUS afficher de Toast/Alert à chaque appel ! Retourne simplement { success: boolean }
  const downloadAndSaveMedia = async (mediaUrl: string, mimeType: string = ''): Promise<{ success: boolean }> => {
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
        const [, base64Data] = mediaUrl.split(',');
        await FileSystem.writeAsStringAsync(fileUri, base64Data, { encoding: FileSystem.EncodingType.Base64 });
        console.log('Ecriture base64 terminée:', fileUri);
      } else {
        // URL HTTP(S), on télécharge normalement
        const downloadResult = await FileSystem.downloadAsync(mediaUrl, fileUri);
        console.log('Résultat téléchargement:', JSON.stringify(downloadResult));
        if (downloadResult.status !== 200) {
          console.warn(`Téléchargement échoué avec le statut ${downloadResult.status}`);
          return { success: false };
        }
      }

      // Ici, on NE FAIT PLUS de ToastAndroid.show ni d'Alert.alert.

      return { success: true };
    } catch (error) {
      console.error('Erreur lors du téléchargement:', error);
      return { success: false };
    }
  };

  // JavaScript injecté dans la WebView pour intercepter plusieurs blobs
  const injectedJavaScript = `
    (function() {
      window._blobQueue = [];
      let _batchTimer = null;

      function flushBlobQueue() {
        if (window._blobQueue.length === 0) return;
        window.ReactNativeWebView.postMessage(JSON.stringify({
          type: 'batchDownload',
          items: window._blobQueue
        }));
        window._blobQueue = [];
      }

      function scheduleFlush() {
        if (_batchTimer) clearTimeout(_batchTimer);
        _batchTimer = setTimeout(function() {
          flushBlobQueue();
          _batchTimer = null;
        }, 500);
      }

      function handleBlobLink(blobUrl) {
        fetch(blobUrl)
          .then(response => response.blob())
          .then(blob => {
            const reader = new FileReader();
            reader.onloadend = function() {
              const base64data = reader.result;
              const isVideo = blob.type.startsWith('video/');
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

      document.addEventListener('click', function(e) {
        const el = e.target.closest('a');
        if (el && typeof el.href === 'string' && el.href.startsWith('blob:')) {
          e.preventDefault();
          handleBlobLink(el.href);
        }
      });
    })();
  `;

  // Handler pour recevoir le “batchDownload” et traiter chaque media
  const handleOnMessage = async (event: any) => {
    try {
      const data = JSON.parse(event.nativeEvent.data);

      if (data.type === 'batchDownload' && Array.isArray(data.items)) {
        console.log(`Réception de ${data.items.length} blobs en batch.`);
        let successCount = 0;

        // Pour chaque entrée, on télécharge sans afficher d'alerte individuelle
        for (const item of data.items) {
          const mediaUrl: string = item.url;
          const mimeType: string = item.mimeType || '';
          const result = await downloadAndSaveMedia(mediaUrl, mimeType);
          if (result.success) {
            successCount++;
          }
        }

        // À la fin de la boucle, on affiche UNE UNIQUE notification
        if (successCount > 0) {
          const message = `${successCount} fichier${successCount > 1 ? 's' : ''} téléchargé${successCount > 1 ? 's' : ''} avec succès !`;
          if (Platform.OS === 'android') {
            ToastAndroid.show(message, ToastAndroid.LONG);
          } else {
            Alert.alert('Téléchargement terminé', message);
          }
        } else {
          // Au cas où aucun media n'aura pu être traité
          Alert.alert('Aucun téléchargement', `Aucun média n'a été téléchargé.`);
        }
      }
    } catch (error) {
      console.error('Erreur lors du traitement du message:', error);
      Alert.alert('Erreur', `Erreur lors du traitement : ${error instanceof Error ? error.message : 'Erreur inconnue'}`);
    }
  };

  return (
    <View style={styles.container}>
      <Stack.Screen
        options={{
          headerShown: false,
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
        onShouldStartLoadWithRequest={() => true}
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
