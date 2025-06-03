import React, { useState, useRef, useEffect } from 'react';
import { StyleSheet, View, ActivityIndicator, Alert, ToastAndroid, Platform } from 'react-native';
import { WebView } from 'react-native-webview';
import * as FileSystem from 'expo-file-system';
import * as MediaLibrary from 'expo-media-library';
import { Stack, useRouter } from 'expo-router';
import { useColorScheme } from '@/hooks/useColorScheme';
import { Colors } from '@/constants/Colors';

// Dossier où les fichiers seront stockés en interne (onglet "Téléchargements")
const DOWNLOADS_DIRECTORY = `${FileSystem.documentDirectory}downloads/`;

export default function WebViewScreen() {
  const [isLoading, setIsLoading] = useState(true);
  const [mediaPermission, setMediaPermission] = useState(false);
  const webViewRef = useRef<WebView>(null);
  const colorScheme = useColorScheme();
  const router = useRouter();

  // 1. Demander la permission d'accéder à la galerie (Pellicule)
  useEffect(() => {
    (async () => {
      const { status } = await MediaLibrary.requestPermissionsAsync();
      setMediaPermission(status === 'granted');
      console.log('Permission MediaLibrary :', status);
    })();
  }, []);

  // 2. Créer le dossier interne "downloads/" s'il n'existe pas
  useEffect(() => {
    async function ensureDownloadsFolder() {
      try {
        const dirInfo = await FileSystem.getInfoAsync(DOWNLOADS_DIRECTORY);
        if (!dirInfo.exists) {
          await FileSystem.makeDirectoryAsync(DOWNLOADS_DIRECTORY, { intermediates: true });
          console.log('Dossier interne créé :', DOWNLOADS_DIRECTORY);
        }
      } catch (error) {
        console.error("Erreur création dossier interne :", error);
      }
    }
    ensureDownloadsFolder();
  }, []);

  /**
   * Écrit un média (image ou vidéo) dans DOWNLOADS_DIRECTORY
   * et renvoie l'URI du fichier local.
   */
  const writeMediaToDownloads = async (
    mediaUrl: string,
    mimeType: string = ''
  ): Promise<{ uri: string | null; success: boolean }> => {
    try {
      console.log('Type MIME :', mimeType);

      // Déterminer si c'est une vidéo ou une image
      let isVideo = false;
      if (mimeType) {
        isVideo = mimeType.startsWith('video/');
      }

      // Déterminer l'extension du fichier
      let fileExtension = 'jpg';
      if (mediaUrl.includes('.')) {
        const parts = mediaUrl.split('.');
        const potentialExt = parts[parts.length - 1].split(/[?#]/)[0].toLowerCase();
        const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'];
        const videoExts = ['mp4', 'mov', 'avi', 'mkv', 'webm', '3gp', 'flv'];

        if (imageExts.includes(potentialExt)) {
          fileExtension = potentialExt;
          isVideo = false;
        } else if (videoExts.includes(potentialExt)) {
          fileExtension = potentialExt;
          isVideo = true;
        }
      } else if (mimeType) {
        if (mimeType.includes('mp4')) fileExtension = 'mp4', isVideo = true;
        else if (mimeType.includes('mov') || mimeType.includes('quicktime')) fileExtension = 'mov', isVideo = true;
        else if (mimeType.includes('avi')) fileExtension = 'avi', isVideo = true;
        else if (mimeType.includes('jpeg') || mimeType.includes('jpg')) fileExtension = 'jpg';
        else if (mimeType.includes('png')) fileExtension = 'png';
        else if (mimeType.includes('gif')) fileExtension = 'gif';
        else if (mimeType.includes('webp')) fileExtension = 'webp';
      }

      // Nom de fichier unique
      const prefix = isVideo ? 'video' : 'image';
      const uniqueFilename = `${prefix}_${Date.now()}.${fileExtension}`;
      const fileUri = `${DOWNLOADS_DIRECTORY}${uniqueFilename}`;

      // Écriture locale dans "downloads/"
      if (mediaUrl.startsWith('data:')) {
        const [, base64Data] = mediaUrl.split(',');
        await FileSystem.writeAsStringAsync(fileUri, base64Data, {
          encoding: FileSystem.EncodingType.Base64,
        });
        console.log('Écriture base64 terminée');
      } else {
        const downloadResult = await FileSystem.downloadAsync(mediaUrl, fileUri);
        console.log('Téléchargement terminé, statut:', downloadResult.status);
        if (downloadResult.status !== 200) {
          console.warn(`Échec téléchargement (status ${downloadResult.status})`);
          return { uri: null, success: false };
        }
      }

      return { uri: fileUri, success: true };
    } catch (error) {
      console.error('Erreur writeMediaToDownloads :', error);
      return { uri: null, success: false };
    }
  };

  /**
   * Sauvegarde un fichier local (URI) dans la Pellicule iOS/Android,
   * en forçant la date de création à "now" via saveToLibraryAsync.
   */
  const saveUriToCameraRoll = async (fileUri: string): Promise<boolean> => {
    if (!mediaPermission) {
      console.warn("Permission MediaLibrary non accordée, impossible d'enregistrer.");
      return false;
    }
    try {
      // On utilise toujours saveToLibraryAsync, qui place l'élément
      // dans la photothèque avec la date de création actuelle.
      await MediaLibrary.saveToLibraryAsync(fileUri);
      console.log('Fichier enregistré dans la pellicule');
      return true;
    } catch (saveErr) {
      console.error('Erreur saveToLibraryAsync :', saveErr);
      return false;
    }
  };

  /**
   * Confirmation utilisateur avant d'enregistrer N fichiers dans la Pellicule.
   */
  const confirmSaveToPellicule = (count: number): Promise<boolean> => {
    return new Promise(resolve => {
      Alert.alert(
        'Confirmation',
        `Voulez-vous enregistrer ${count} fichier${count > 1 ? 's' : ''} dans la Pellicule ?`,
        [
          { text: 'Annuler', style: 'cancel', onPress: () => resolve(false) },
          { text: 'Enregistrer', onPress: () => resolve(true) },
        ],
        { cancelable: true }
      );
    });
  };

  // 3. Script injecté dans la WebView pour capter plusieurs blobs
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
            console.error('Erreur conversion blob en base64 :', err);
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

  // 4. Handler pour recevoir le batch de blobs et traiter chaque média
  const handleOnMessage = async (event: any) => {
    try {
      const data = JSON.parse(event.nativeEvent.data);

      if (data.type === 'batchDownload' && Array.isArray(data.items)) {
        console.log(`Réception de ${data.items.length} blobs en batch.`);

        // 4.a. Écrire TOUTES les ressources dans /downloads/
        const fileUris: string[] = [];
        let writeFailures = 0;

        for (const item of data.items) {
          const mediaUrl: string = item.url;
          const mimeType: string = item.mimeType || '';
          const writeResult = await writeMediaToDownloads(mediaUrl, mimeType);
          if (writeResult.success && writeResult.uri) {
            fileUris.push(writeResult.uri);
          } else {
            writeFailures++;
          }
        }

        // 4.b. Si certains fichiers n'ont pas pu être écrits en local
        if (writeFailures > 0) {
          const failMsg = `${writeFailures} échec${writeFailures > 1 ? 's' : ''} lors de l’écriture locale.`;
          if (Platform.OS === 'android') {
            ToastAndroid.show(failMsg, ToastAndroid.LONG);
          } else {
            Alert.alert('Attention', failMsg);
          }
        }

        // 4.c. Demander confirmation pour la Pellicule
        const totalToSave = fileUris.length;
        if (totalToSave === 0) {
          console.log('Aucun fichier valide à enregistrer.');
          return;
        }

        const userConfirmed = await confirmSaveToPellicule(totalToSave);
        if (!userConfirmed) {
          const message = `${totalToSave} fichier${totalToSave > 1 ? 's' : ''} enregistré${totalToSave > 1 ? 's' : ''} uniquement dans “Téléchargements”`;
          if (Platform.OS === 'android') {
            ToastAndroid.show(message, ToastAndroid.LONG);
          } else {
            Alert.alert('Terminé', message);
          }
          return;
        }

        // 4.d. Enregistrer chaque URI dans la Pellicule
        let successCount = 0;
        let failureCount = 0;

        for (const uri of fileUris) {
          const saved = await saveUriToCameraRoll(uri);
          if (saved) {
            successCount++;
          } else {
            failureCount++;
          }
        }

        // 4.e. Notifications finales
        if (successCount > 0) {
          const msg = `${successCount} fichier${successCount > 1 ? 's' : ''} enregistré${successCount > 1 ? 's' : ''} dans la Pellicule\n(et déjà dans “Téléchargements”)`;
          if (Platform.OS === 'android') {
            ToastAndroid.show(msg, ToastAndroid.LONG);
          } else {
            Alert.alert('Enregistrement terminé', msg);
          }
        }
        if (failureCount > 0) {
          const failMsg2 = `${failureCount} échec${failureCount > 1 ? 's' : ''} lors de l’enregistrement dans la Pellicule.`;
          if (Platform.OS === 'android') {
            ToastAndroid.show(failMsg2, ToastAndroid.LONG);
          } else {
            Alert.alert('Attention', failMsg2);
          }
        }
      }
    } catch (error) {
      console.error('Erreur du handler onMessage :', error);
      Alert.alert('Erreur', `Une erreur est survenue : ${error instanceof Error ? error.message : 'inconnue'}`);
    }
  };

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ headerShown: false }} />
      {isLoading && (
        <ActivityIndicator
          style={styles.loadingIndicator}
          size="large"
          color={Colors[colorScheme ?? 'light'].tint}
        />
      )}
      <WebView
        ref={webViewRef}
        source={{ uri: 'https://rdrop.test.jules.ryvie.fr' }}
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
