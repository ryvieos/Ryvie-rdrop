import React, { useState, useRef, useEffect } from 'react';
import { StyleSheet, View, ActivityIndicator, Alert, ToastAndroid, Platform, Text, Image } from 'react-native';
import { WebView } from 'react-native-webview';
import * as FileSystem from 'expo-file-system/legacy';
import * as MediaLibrary from 'expo-media-library';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Stack, useRouter } from 'expo-router';
import { useColorScheme } from '@/hooks/useColorScheme';
import { Colors } from '@/constants/Colors';

// Dossier où les fichiers seront stockés en interne (onglet "Téléchargements")
const DOWNLOADS_DIRECTORY = `${FileSystem.documentDirectory}downloads/`;
const LOCAL_API_URL = 'http://ryvie.local:3002/api/settings/ryvie-domains';
const LOCAL_WEBVIEW_URL = 'http://ryvie.local:8080';
const STORAGE_KEY_RDROP_DOMAIN = '@rdrop_public_domain';

export default function WebViewScreen() {
  const [isLoading, setIsLoading] = useState(true);
  const [isResolvingUrl, setIsResolvingUrl] = useState(true);
  const [mediaPermission, setMediaPermission] = useState(false);
  const [webViewUrl, setWebViewUrl] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const webViewRef = useRef<WebView>(null);
  const colorScheme = useColorScheme();
  const router = useRouter();

  // 1. Résoudre l'URL de la WebView au lancement
  useEffect(() => {
    resolveWebViewUrl();
  }, []);

  // 2. Demander la permission d'accéder à la galerie (Pellicule)
  useEffect(() => {
    (async () => {
      const { status } = await MediaLibrary.requestPermissionsAsync();
      setMediaPermission(status === 'granted');
      console.log('Permission MediaLibrary :', status);
    })();
  }, []);

  /**
   * Résout l'URL à charger dans la WebView :
   * 1. Tente de joindre l'API locale pour récupérer le domaine public rdrop
   * 2. Si succès : stocke le domaine et charge l'URL locale
   * 3. Si échec : charge le domaine public stocké ou affiche un message d'erreur
   */
  const resolveWebViewUrl = async () => {
    setIsResolvingUrl(true);
    try {
      // Tentative de connexion à l'API locale
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000); // Timeout 5s

      const response = await fetch(LOCAL_API_URL, {
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (response.ok) {
        const data = await response.json();
        if (data.success && data.domains && data.domains.rdrop) {
          const publicDomain = data.domains.rdrop;
          // Stocker le domaine public pour usage ultérieur
          await AsyncStorage.setItem(STORAGE_KEY_RDROP_DOMAIN, publicDomain);
          console.log('Domaine public rdrop stocké :', publicDomain);
          // Charger l'URL locale car le Ryvie est accessible
          setWebViewUrl(LOCAL_WEBVIEW_URL);
          setErrorMessage(null);
          setIsResolvingUrl(false);
          return;
        }
      }
      // Si la réponse n'est pas OK ou les données sont invalides, on passe au fallback
      throw new Error('API locale inaccessible ou données invalides');
    } catch (error) {
      console.log('Impossible de joindre l\'API locale, tentative de récupération du domaine stocké...');
      // Récupérer le domaine public stocké
      const storedDomain = await AsyncStorage.getItem(STORAGE_KEY_RDROP_DOMAIN);
      if (storedDomain) {
        console.log('Utilisation du domaine public stocké :', storedDomain);
        setWebViewUrl(`https://${storedDomain}`);
        setErrorMessage(null);
        setIsResolvingUrl(false);
      } else {
        console.log('Aucun domaine public stocké, affichage du message d\'erreur');
        setErrorMessage(
          'Veuillez vous connecter une première fois à proximité de votre Ryvie pour configurer l\'application.'
        );
        setWebViewUrl(null);
        setIsResolvingUrl(false);
      }
    }
  };

  // 3. Créer le dossier interne "downloads/" s'il n'existe pas
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
        if (!FileSystem.EncodingType || !('Base64' in FileSystem.EncodingType)) {
          console.warn('FileSystem Base64 encoding not available, skipping base64 write.');
          return { uri: null, success: false };
        }
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
          const message = `${totalToSave} fichier${totalToSave > 1 ? 's' : ''} enregistré${totalToSave > 1 ? 's' : ''} dans la Pellicule”`;
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
          const msg = `${successCount} fichier${successCount > 1 ? 's' : ''} enregistré${successCount > 1 ? 's' : ''} dans la Pellicule`;
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
      {isResolvingUrl ? (
        // Affichage du spinner pendant la résolution de l'URL
        <View style={styles.loadingContainer}>
          <Image
            source={require('@/assets/images/ryvielogo.png')}
            style={styles.logo}
            resizeMode="contain"
          />
          <ActivityIndicator
            size="large"
            color={Colors[colorScheme ?? 'light'].tint}
            style={styles.spinner}
          />
          <Text style={styles.loadingTitle}>Connexion à votre Ryvie</Text>
          <Text style={styles.loadingSubtitle}>Recherche de votre appareil sur le réseau local...</Text>
        </View>
      ) : webViewUrl === null ? (
        // Affichage du message d'erreur si aucune URL n'est disponible
        <View style={styles.errorContainer}>
          <Text style={styles.errorTitle}>Connexion impossible</Text>
          <Text style={styles.errorMessage}>{errorMessage}</Text>
        </View>
      ) : (
        <>
          {isLoading && (
            <ActivityIndicator
              style={styles.loadingIndicator}
              size="large"
              color={Colors[colorScheme ?? 'light'].tint}
            />
          )}
          <WebView
            ref={webViewRef}
            source={{ uri: webViewUrl }}
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
        </>
      )}
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
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#f8f9fa',
    paddingHorizontal: 32,
  },
  logo: {
    width: 120,
    height: 120,
    marginBottom: 32,
  },
  spinner: {
    marginBottom: 24,
  },
  loadingTitle: {
    fontSize: 20,
    fontWeight: '600',
    color: '#1a1a1a',
    marginBottom: 8,
    textAlign: 'center',
  },
  loadingSubtitle: {
    fontSize: 14,
    color: '#666',
    textAlign: 'center',
    lineHeight: 20,
  },
  errorContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
    backgroundColor: '#f5f5f5',
  },
  errorTitle: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#333',
    marginBottom: 16,
    textAlign: 'center',
  },
  errorMessage: {
    fontSize: 16,
    color: '#666',
    textAlign: 'center',
    lineHeight: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
