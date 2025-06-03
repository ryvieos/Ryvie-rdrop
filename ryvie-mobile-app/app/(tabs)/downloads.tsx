import React, { useState, useEffect, useCallback } from 'react';
import {
  StyleSheet,
  View,
  Text,
  Image,
  FlatList,
  TouchableOpacity,
  Alert,
  ActivityIndicator,
  Share,
  Platform,
  ToastAndroid
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from 'expo-router';
import * as FileSystem from 'expo-file-system';
import * as MediaLibrary from 'expo-media-library';
import { useColorScheme } from '@/hooks/useColorScheme';
import { Colors } from '@/constants/Colors';

// Dossier où les images téléchargées seront stockées
const DOWNLOADS_DIRECTORY = `${FileSystem.documentDirectory}downloads/`;

// Type pour media (image ou vidéo)
interface DownloadedMedia {
  uri: string;
  fileName: string;
  date: Date;
  isVideo: boolean;
  type: string;
}

export default function DownloadsScreen() {
  const [medias, setMedias] = useState<DownloadedMedia[]>([]);
  const [loading, setLoading] = useState(true);
  // Mode sélection activé par défaut
  const [selectionMode, setSelectionMode] = useState(true);
  const [selectedMedias, setSelectedMedias] = useState<DownloadedMedia[]>([]);
  const colorScheme = useColorScheme();

  // 1. Création du dossier de téléchargements si nécessaire
  useEffect(() => {
    (async () => {
      try {
        const dirInfo = await FileSystem.getInfoAsync(DOWNLOADS_DIRECTORY);
        if (!dirInfo.exists) {
          await FileSystem.makeDirectoryAsync(DOWNLOADS_DIRECTORY, { intermediates: true });
        }
      } catch (err) {
        console.error("Erreur dossier downloads :", err);
      }
    })();
  }, []);

  // 2. Recharge la liste des fichiers à chaque focus de l'écran
  useFocusEffect(
    useCallback(() => {
      loadMedias();
      return () => {};
    }, [])
  );

  // 3. Charge et trie les médias
  const loadMedias = async () => {
    try {
      setLoading(true);
      const files = await FileSystem.readDirectoryAsync(DOWNLOADS_DIRECTORY);
      const mediaPromises = files.map(async (fileName) => {
        const ext = fileName.split('.').pop()?.toLowerCase() || '';
        const fileUri = DOWNLOADS_DIRECTORY + fileName;
        const fileInfo = await FileSystem.getInfoAsync(fileUri);
        const videoExts = ['mp4', 'mov', 'avi', 'mkv', 'webm', '3gp', 'flv'];
        const isVideo = videoExts.includes(ext) || fileName.startsWith('video_');
        return {
          uri: fileUri,
          fileName,
          date: new Date(fileInfo.modificationTime * 1000),
          isVideo,
          type: ext
        };
      });
      const mediaData = await Promise.all(mediaPromises);
      mediaData.sort((a, b) => b.date.getTime() - a.date.getTime());
      setMedias(mediaData);
    } catch (err) {
      console.error("Erreur chargement médias :", err);
    } finally {
      setLoading(false);
    }
  };

  // 4. Enregistrer un unique média dans la galerie
  const saveToGallery = async (mediaUri: string, isVideo: boolean) => {
    try {
      const { status } = await MediaLibrary.requestPermissionsAsync();
      if (status !== 'granted') {
        const type = isVideo ? 'vidéo' : 'image';
        Alert.alert("Permission refusée", `Impossible de sauvegarder la ${type} sans autorisation.`);
        return;
      }
      await MediaLibrary.createAssetAsync(mediaUri);
      const label = isVideo ? 'Vidéo' : 'Image';
      Platform.OS === 'android'
        ? ToastAndroid.show(`${label} sauvegardée`, ToastAndroid.LONG)
        : Alert.alert("Succès", `${label} sauvegardée`);
    } catch (err) {
      console.error("Erreur saveToGallery:", err);
      Alert.alert("Erreur", "Échec de l’enregistrement dans la galerie.");
    }
  };

  // 5. Supprimer un unique média
  const deleteMedia = async (mediaUri: string, fileName: string, isVideo: boolean) => {
    const type = isVideo ? 'vidéo' : 'image';
    Alert.alert(
      "Supprimer",
      `Supprimer cette ${type} ?`,
      [
        { text: "Annuler", style: "cancel" },
        {
          text: "Supprimer",
          style: "destructive",
          onPress: async () => {
            try {
              await FileSystem.deleteAsync(mediaUri, { idempotent: true });
              setMedias(medias.filter(m => m.fileName !== fileName));
              Platform.OS === 'android'
                ? ToastAndroid.show(`${type.charAt(0).toUpperCase() + type.slice(1)} supprimée`, ToastAndroid.LONG)
                : Alert.alert("Succès", `${type.charAt(0).toUpperCase() + type.slice(1)} supprimée`);
            } catch (err) {
              console.error("Erreur deleteMedia :", err);
              Alert.alert("Erreur", `Impossible de supprimer la ${type}.`);
            }
          }
        }
      ]
    );
  };

  // 6. Partager un unique média
  const shareMedia = async (mediaUri: string, isVideo: boolean) => {
    try {
      const label = isVideo ? 'Vidéo' : 'Image';
      await Share.share({ url: mediaUri, message: `${label} partagée depuis Ryvie` });
    } catch (err) {
      console.error("Erreur shareMedia:", err);
    }
  };

  // 7. Partager plusieurs médias
  const shareMultipleMedias = async () => {
    if (selectedMedias.length === 0) return;
    try {
      if (selectedMedias.length === 1) {
        await shareMedia(selectedMedias[0].uri, selectedMedias[0].isVideo);
      } else if (Platform.OS === 'ios') {
        const videoCount = selectedMedias.filter(m => m.isVideo).length;
        const imageCount = selectedMedias.length - videoCount;
        let msg = '';
        if (videoCount > 0 && imageCount > 0) {
          msg = `${imageCount} image(s) et ${videoCount} vidéo(s) partagées depuis Ryvie`;
        } else if (videoCount > 0) {
          msg = `${videoCount} vidéo(s) partagée(s) depuis Ryvie`;
        } else {
          msg = `${imageCount} image(s) partagée(s) depuis Ryvie`;
        }
        // Partager le premier média avec un message
        await Share.share({ message: msg, url: selectedMedias[0].uri });
      } else {
        // Sur Android, on ne peut partager qu'un média à la fois
        await shareMedia(selectedMedias[0].uri, selectedMedias[0].isVideo);
        if (selectedMedias.length > 1) {
          ToastAndroid.show('Seul le premier média a été partagé', ToastAndroid.LONG);
        }
      }
    } catch (error) {
      console.error("Erreur lors du partage multiple :", error);
      Alert.alert("Erreur", "Impossible de partager les médias sélectionnés.");
    }
  };

  // 8. Sauvegarder plusieurs médias
  const saveMultipleToGallery = async () => {
    if (selectedMedias.length === 0) return;
    try {
      const { status } = await MediaLibrary.requestPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert("Permission refusée", "Impossible sans accès à la galerie.");
        return;
      }
      let successCount = 0, imageCount = 0, videoCount = 0;
      for (const media of selectedMedias) {
        try {
          await MediaLibrary.createAssetAsync(media.uri);
          successCount++;
          media.isVideo ? videoCount++ : imageCount++;
        } catch {
          /* ignore */
        }
      }
      if (successCount > 0) {
        let msg = '';
        if (imageCount > 0 && videoCount > 0) {
          msg = `${imageCount} image(s) et ${videoCount} vidéo(s) sauvegardée(s)`;
        } else if (videoCount > 0) {
          msg = `${videoCount} vidéo(s) sauvegardée(s)`;
        } else {
          msg = `${imageCount} image(s) sauvegardée(s)`;
        }
        Platform.OS === 'android'
          ? ToastAndroid.show(msg, ToastAndroid.LONG)
          : Alert.alert("Succès", msg);
        exitSelectionMode();
      } else {
        Alert.alert("Erreur", "Aucun média sauvegardé.");
      }
    } catch (err) {
      console.error("Erreur saveMultipleToGallery:", err);
      Alert.alert("Erreur", "Échec de la sauvegarde multiple.");
    }
  };

  // 9. Supprimer plusieurs médias
  const deleteMultipleMedias = async () => {
    if (selectedMedias.length === 0) return;
    const videoCount = selectedMedias.filter(m => m.isVideo).length;
    const imageCount = selectedMedias.length - videoCount;
    let desc = '';
    if (videoCount > 0 && imageCount > 0) {
      desc = `${imageCount} image(s) et ${videoCount} vidéo(s)`;
    } else if (videoCount > 0) {
      desc = `${videoCount} vidéo(s)`;
    } else {
      desc = `${imageCount} image(s)`;
    }
    Alert.alert(
      "Supprimer",
      `Supprimer ${desc} ?`,
      [
        { text: "Annuler", style: "cancel" },
        {
          text: "Supprimer",
          style: "destructive",
          onPress: async () => {
            try {
              let deletedCount = 0;
              const toDeleteNames = selectedMedias.map(m => m.fileName);
              for (const m of selectedMedias) {
                try {
                  await FileSystem.deleteAsync(m.uri, { idempotent: true });
                  deletedCount++;
                } catch {
                  /* ignore */
                }
              }
              if (deletedCount > 0) {
                setMedias(medias.filter(m => !toDeleteNames.includes(m.fileName)));
                const msg = `${deletedCount} média(s) supprimé(s)`;
                Platform.OS === 'android'
                  ? ToastAndroid.show(msg, ToastAndroid.LONG)
                  : Alert.alert("Succès", msg);
                // Maintenir le mode sélection actif
              }
            } catch (err) {
              console.error("Erreur deleteMultipleMedias:", err);
              Alert.alert("Erreur", "Impossible de supprimer certains médias.");
            }
          }
        }
      ]
    );
  };

  // Activer/désactiver le mode sélection
  const toggleSelectionMode = () => {
    if (selectionMode) exitSelectionMode();
    else setSelectionMode(true);
  };
  const exitSelectionMode = () => {
    setSelectionMode(false);
    setSelectedMedias([]);
  };

  // Sélection / désélection d’un item
  const toggleMediaSelection = (media: DownloadedMedia) => {
    const idx = selectedMedias.findIndex(m => m.fileName === media.fileName);
    if (idx >= 0) {
      setSelectedMedias(selectedMedias.filter((_, i) => i !== idx));
    } else {
      setSelectedMedias([...selectedMedias, media]);
    }
  };

  // Tout sélectionner / Tout désélectionner
  const toggleSelectAll = () => {
    if (selectedMedias.length < medias.length) {
      setSelectedMedias([...medias]);
    } else {
      setSelectedMedias([]);
    }
  };

  // Options pour un unique média (alert avec actions)
  const showMediaOptions = (media: DownloadedMedia) => {
    const type = media.isVideo ? 'vidéo' : 'image';
    Alert.alert(
      "Options",
      `Que faire de cette ${type} ?`,
      [
        { text: "Annuler", style: "cancel" },
        { text: "Télécharger", onPress: () => saveToGallery(media.uri, media.isVideo) },
        { text: "Partager", onPress: () => shareMedia(media.uri, media.isVideo) },
        { text: "Supprimer", onPress: () => deleteMedia(media.uri, media.fileName, media.isVideo), style: "destructive" }
      ]
    );
  };

  // Rend chaque media en grille
  const renderMediaItem = ({ item }: { item: DownloadedMedia }) => {
    const isSelected = selectedMedias.some(m => m.fileName === item.fileName);
    return (
      <TouchableOpacity
        style={[styles.mediaContainer, isSelected && styles.selectedMediaContainer]}
        onPress={() => selectionMode ? toggleMediaSelection(item) : showMediaOptions(item)}
        onLongPress={() => {
          if (!selectionMode) {
            setSelectionMode(true);
            toggleMediaSelection(item);
          }
        }}
      >
        {item.isVideo ? (
          <View style={styles.videoContainer}>
            <Image source={{ uri: item.uri }} style={styles.mediaPreview} />
            <View style={styles.videoOverlay}>
              <Ionicons name="play-circle" size={36} color="white" />
            </View>
            <View style={styles.videoIconContainer}>
              <Ionicons name="videocam" size={20} color="white" />
            </View>
          </View>
        ) : (
          <Image source={{ uri: item.uri }} style={styles.mediaPreview} />
        )}

        {isSelected && (
          <View style={styles.selectedOverlay}>
            <Ionicons name="checkmark-circle" size={28} color="#4CAF50" />
          </View>
        )}

        <Text style={styles.mediaDate}>
          {item.date.toLocaleDateString()} {item.date.toLocaleTimeString()}
        </Text>
      </TouchableOpacity>
    );
  };

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={[styles.customHeader, { backgroundColor: Colors[colorScheme ?? 'light'].tint }]}>
        {!selectionMode ? (
          <Text style={styles.headerTitle}>Médias téléchargés</Text>
        ) : (
          <>
            <View style={styles.headerLeft}>
              {/* Bouton pour quitter le mode sélection */}
              <TouchableOpacity onPress={exitSelectionMode} style={{ marginRight: 16 }}>
                <Ionicons name="close-circle" size={28} color="white" />
              </TouchableOpacity>
              <Text style={styles.headerTitle}>
                {selectedMedias.length} sélectionné{selectedMedias.length > 1 ? 's' : ''}
              </Text>
            </View>
            {/* Bouton Tout sélectionner / Tout désélectionner */}
            <TouchableOpacity onPress={toggleSelectAll} style={styles.headerRightButton}>
              <Ionicons
                name={selectedMedias.length === medias.length ? "checkbox-outline" : "checkmark-done-circle"}
                size={28}
                color="white"
              />
            </TouchableOpacity>
          </>
        )}
      </View>

      {loading ? (
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color={Colors[colorScheme ?? 'light'].tint} />
          <Text style={styles.loadingText}>Chargement des médias...</Text>
        </View>
      ) : medias.length > 0 ? (
        <>
          {/* Grille */}
          <FlatList
            data={medias}
            renderItem={renderMediaItem}
            keyExtractor={item => item.fileName}
            numColumns={2}
            contentContainerStyle={[styles.mediaList, { paddingBottom: selectionMode ? 140 : 60 }]}
          />

          {/* Groupe de boutons flottants en mode sélection (Tout sélectionner, Partager, Télécharger, Supprimer) */}
          {selectionMode && (
            <View style={styles.floatingGroup}>
              {/* Tout sélectionner / Tout désélectionner */}
              <TouchableOpacity 
                style={[styles.floatingButton, styles.floatingSelect]} 
                onPress={toggleSelectAll}
              >
                <Ionicons
                  name={selectedMedias.length === medias.length ? "checkmark-done-circle" : "checkmark-circle-outline"}
                  size={24}
                  color="white"
                />
              </TouchableOpacity>
              
              {/* Télécharger */}
              <TouchableOpacity 
                style={[styles.floatingButton, styles.floatingDownload]}
                onPress={saveMultipleToGallery}
              >
                <Ionicons name="download" size={24} color="white" />
              </TouchableOpacity>
              
              {/* Supprimer */}
              <TouchableOpacity 
                style={[styles.floatingButton, styles.floatingDelete]} 
                onPress={deleteMultipleMedias}
              >
                <Ionicons name="trash" size={24} color="white" />
              </TouchableOpacity>
            </View>
          )}
        </>
      ) : (
        <View style={styles.emptyContainer}>
          <View style={{ flexDirection: 'row', justifyContent: 'center' }}>
            <Ionicons name="images-outline" size={60} color="#ccc" style={{ marginRight: 10 }} />
            <Ionicons name="videocam-outline" size={60} color="#ccc" style={{ marginLeft: 10 }} />
          </View>
          <Text style={styles.emptyText}>Aucun média téléchargé</Text>
          <Text style={styles.emptySubText}>Les images et vidéos que vous téléchargez apparaîtront ici</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
  },
  // Header
  customHeader: {
    height: 56,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    justifyContent: 'space-between',
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  headerTitle: {
    color: 'white',
    fontSize: 18,
    fontWeight: 'bold',
  },
  headerRightButton: {
    padding: 4,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  loadingText: {
    marginTop: 10,
    fontSize: 16,
    color: '#666',
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  emptyText: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#666',
    marginTop: 20,
  },
  emptySubText: {
    fontSize: 14,
    color: '#999',
    marginTop: 8,
    textAlign: 'center',
  },
  mediaList: {
    padding: 8,
  },
  mediaContainer: {
    flex: 1,
    margin: 8,
    borderRadius: 8,
    overflow: 'hidden',
    backgroundColor: '#f0f0f0',
    position: 'relative',
  },
  selectedMediaContainer: {
    borderWidth: 3,
    borderColor: '#4CAF50',
    borderRadius: 8,
  },
  selectedOverlay: {
    position: 'absolute',
    top: 5,
    right: 5,
    backgroundColor: 'rgba(255, 255, 255, 0.8)',
    borderRadius: 14,
  },
  mediaPreview: {
    aspectRatio: 1,
    width: '100%',
  },
  mediaDate: {
    fontSize: 12,
    color: '#666',
    padding: 8,
    backgroundColor: '#f9f9f9',
  },
  videoContainer: {
    position: 'relative',
  },
  videoOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.2)',
  },
  videoIconContainer: {
    position: 'absolute',
    top: 8,
    left: 8,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    borderRadius: 4,
    padding: 4,
  },

  // Bouton flottant “Sélectionner” (désactivé ici, car on démarre en mode sélection)
  selectButton: {
    display: 'none',
  },

  // Groupe de boutons flottants en mode sélection (Tout sélectionner, Partager, Télécharger, Supprimer)
  floatingGroup: {
    position: 'absolute',
    bottom: 30,
    right: 16,
    flexDirection: 'row',
    alignItems: 'center',
  },
  floatingButton: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#46bdff', // Couleur Ryvie
    padding: 12,
    borderRadius: 24,
    marginLeft: 10,
    elevation: 6,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.3,
    shadowRadius: 4,
    width: 48,
    height: 48,
  },
  floatingSelect: {
    backgroundColor: '#1da6f8', // Couleur Ryvie
  },
  floatingShare: {
    backgroundColor: '#59d7ff', // Couleur Ryvie
  },
  floatingDownload: {
    backgroundColor: '#46bdff', // Couleur Ryvie
  },
  floatingDelete: {
    backgroundColor: '#023d8b', // Couleur Ryvie foncée
  },

  // Barre d’actions (cachée)
  actionBar: {
    display: 'none',
  }
});
