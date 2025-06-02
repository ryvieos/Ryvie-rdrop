import React, { useState, useEffect } from 'react';
import { StyleSheet, View, Text, Image, FlatList, TouchableOpacity, Alert, ActivityIndicator, Share, Platform, ToastAndroid } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Stack } from 'expo-router';
import * as FileSystem from 'expo-file-system';
import * as MediaLibrary from 'expo-media-library';
import { useColorScheme } from '@/hooks/useColorScheme';
import { Colors } from '@/constants/Colors';

// Dossier où les images téléchargées seront stockées
const DOWNLOADS_DIRECTORY = `${FileSystem.documentDirectory}downloads/`;

// Définir l'interface pour les médias (images et vidéos)
interface DownloadedMedia {
  uri: string;
  fileName: string;
  date: Date;
  isVideo: boolean; // true pour les vidéos, false pour les images
  type: string; // type MIME ou extension
}

export default function DownloadsScreen() {
  const [medias, setMedias] = useState<DownloadedMedia[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedMedias, setSelectedMedias] = useState<DownloadedMedia[]>([]);
  const colorScheme = useColorScheme();

  useEffect(() => {
    async function setupDownloadsFolder() {
      try {
        // Vérifier si le dossier de téléchargements existe
        const dirInfo = await FileSystem.getInfoAsync(DOWNLOADS_DIRECTORY);
        if (!dirInfo.exists) {
          await FileSystem.makeDirectoryAsync(DOWNLOADS_DIRECTORY, { intermediates: true });
        }
        
        // Charger les médias (images et vidéos)
        loadMedias();
      } catch (error) {
        console.error("Erreur lors de la vérification du dossier de téléchargements:", error);
        setLoading(false);
      }
    }
    
    setupDownloadsFolder();
  }, []);

  // Charger la liste des médias téléchargés (images et vidéos)
  const loadMedias = async () => {
    try {
      setLoading(true);
      
      // Lire le contenu du répertoire de téléchargements
      const files = await FileSystem.readDirectoryAsync(DOWNLOADS_DIRECTORY);
      
      // Déterminer le type de fichier en fonction de l'extension
      const mediaPromises = files.map(async (fileName) => {
        const ext = fileName.split('.').pop()?.toLowerCase() || '';
        const fileUri = `${DOWNLOADS_DIRECTORY}${fileName}`;
        const fileInfo = await FileSystem.getInfoAsync(fileUri);
        
        // Déterminer si c'est une vidéo ou une image
        const imageExtensions = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'];
        const videoExtensions = ['mp4', 'mov', 'avi', 'mkv', 'webm', '3gp', 'flv'];
        
        // Déterminer si c'est une vidéo ou une image basé sur le préfixe du nom de fichier ou l'extension
        const isVideo = videoExtensions.includes(ext) || fileName.startsWith('video_');
        
        return {
          uri: fileUri,
          fileName,
          date: new Date(fileInfo.modificationTime * 1000), // Convertir le timestamp en Date
          isVideo,
          type: ext
        };
      });
      
      // Attendre que toutes les promesses soient résolues
      const mediaData = await Promise.all(mediaPromises);
      
      // Trier les médias par date (plus récents en premier)
      const sortedMedias = mediaData.sort((a, b) => b.date.getTime() - a.date.getTime());
      
      setMedias(sortedMedias);
    } catch (error) {
      console.error("Erreur lors du chargement des médias:", error);
    } finally {
      setLoading(false);
    }
  };

  // Sauvegarder un média dans la galerie
  const saveToGallery = async (mediaUri: string, isVideo: boolean) => {
    try {
      const { status } = await MediaLibrary.requestPermissionsAsync();
      if (status !== 'granted') {
        const mediaType = isVideo ? "vidéo" : "image";
        Alert.alert("Permission refusée", `Nous avons besoin de votre permission pour sauvegarder la ${mediaType} dans la galerie.`);
        return;
      }
      
      await MediaLibrary.createAssetAsync(mediaUri);
      
      const mediaType = isVideo ? "Vidéo" : "Image";
      if (Platform.OS === 'android') {
        ToastAndroid.show(`${mediaType} sauvegardée dans la galerie`, ToastAndroid.LONG);
      } else {
        Alert.alert("Succès", `${mediaType} sauvegardée dans la galerie.`);
      }
    } catch (error) {
      const mediaType = isVideo ? "vidéo" : "image";
      console.error(`Erreur lors de la sauvegarde de la ${mediaType} dans la galerie:`, error);
      Alert.alert("Erreur", `Impossible de sauvegarder la ${mediaType} dans la galerie.`);
    }
  };

  // Supprimer un média
  const deleteMedia = async (mediaUri: string, fileName: string, isVideo: boolean) => {
    try {
      const mediaType = isVideo ? "vidéo" : "image";
      Alert.alert(
        "Confirmation",
        `Êtes-vous sûr de vouloir supprimer cette ${mediaType} ?`,
        [
          { text: "Annuler", style: "cancel" },
          {
            text: "Supprimer", 
            style: "destructive",
            onPress: async () => {
              try {
                await FileSystem.deleteAsync(mediaUri, { idempotent: true });
                setMedias(medias.filter(media => media.fileName !== fileName));
                
                if (Platform.OS === 'android') {
                  ToastAndroid.show(`${mediaType.charAt(0).toUpperCase() + mediaType.slice(1)} supprimée`, ToastAndroid.LONG);
                } else {
                  Alert.alert("Succès", `${mediaType.charAt(0).toUpperCase() + mediaType.slice(1)} supprimée avec succès.`);
                }
              } catch (error) {
                console.error(`Erreur lors de la suppression de la ${mediaType}:`, error);
                Alert.alert("Erreur", `Impossible de supprimer la ${mediaType}.`);
              }
            }
          }
        ]
      );
    } catch (error) {
      console.error("Erreur lors de la demande de suppression:", error);
      Alert.alert("Erreur", "Une erreur est survenue lors de la suppression.");
    }
  };

  // Partager un média
  const shareMedia = async (mediaUri: string, isVideo: boolean) => {
    try {
      const mediaType = isVideo ? "Vidéo" : "Image";
      await Share.share({
        url: mediaUri,
        message: `${mediaType} partagée depuis Ryvie`
      });
    } catch (error) {
      console.error("Erreur lors du partage:", error);
    }
  };

  // Partager plusieurs médias
  const shareMultipleMedias = async () => {
    if (selectedMedias.length === 0) return;
    
    try {
      if (selectedMedias.length === 1) {
        await shareMedia(selectedMedias[0].uri, selectedMedias[0].isVideo);
      } else {
        // Sur iOS, on peut partager plusieurs fichiers
        if (Platform.OS === 'ios') {
          // Compter le nombre de vidéos et d'images
          const videoCount = selectedMedias.filter(media => media.isVideo).length;
          const imageCount = selectedMedias.length - videoCount;
          
          let messageText = '';
          if (videoCount > 0 && imageCount > 0) {
            messageText = `${imageCount} image(s) et ${videoCount} vidéo(s) partagées depuis Ryvie`;
          } else if (videoCount > 0) {
            messageText = `${videoCount} vidéo(s) partagée(s) depuis Ryvie`;
          } else {
            messageText = `${imageCount} image(s) partagée(s) depuis Ryvie`;
          }
          
          // Type compatible avec iOS uniquement
          const shareOptions = {
            message: messageText,
            url: selectedMedias[0].uri, // Fallback pour la compatibilité
            urls: selectedMedias.map(media => media.uri) // iOS uniquement
          };
          // @ts-ignore - 'urls' est valide sur iOS mais TypeScript ne le connaît pas
          await Share.share(shareOptions);
        } else {
          // Sur Android, on partage seulement le premier média
          await shareMedia(selectedMedias[0].uri, selectedMedias[0].isVideo);
          if (selectedMedias.length > 1) {
            ToastAndroid.show('Seul le premier média a été partagé', ToastAndroid.LONG);
          }
        }
      }
    } catch (error) {
      console.error("Erreur lors du partage multiple:", error);
      Alert.alert("Erreur", "Impossible de partager les médias sélectionnés.");
    }
  };

  // Sauvegarder plusieurs médias dans la galerie
  const saveMultipleToGallery = async () => {
    if (selectedMedias.length === 0) return;

    try {
      const { status } = await MediaLibrary.requestPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert("Permission refusée", "Nous avons besoin de votre permission pour sauvegarder les médias dans la galerie.");
        return;
      }

      let successCount = 0;
      let imageCount = 0;
      let videoCount = 0;
      
      for (const media of selectedMedias) {
        try {
          await MediaLibrary.createAssetAsync(media.uri);
          successCount++;
          if (media.isVideo) {
            videoCount++;
          } else {
            imageCount++;
          }
        } catch (e) {
          console.error(`Erreur lors de la sauvegarde de ${media.fileName}:`, e);
        }
      }

      if (successCount > 0) {
        let message = '';
        if (imageCount > 0 && videoCount > 0) {
          message = `${imageCount} image(s) et ${videoCount} vidéo(s) sauvegardée(s) dans la galerie`;
        } else if (videoCount > 0) {
          message = `${videoCount} vidéo(s) sauvegardée(s) dans la galerie`;
        } else {
          message = `${imageCount} image(s) sauvegardée(s) dans la galerie`;
        }
        
        if (Platform.OS === 'android') {
          ToastAndroid.show(message, ToastAndroid.LONG);
        } else {
          Alert.alert("Succès", message);
        }
        exitSelectionMode();
      } else {
        Alert.alert("Erreur", "Impossible de sauvegarder les médias dans la galerie.");
      }
    } catch (error) {
      console.error("Erreur lors de la sauvegarde multiple:", error);
      Alert.alert("Erreur", "Impossible de sauvegarder les médias dans la galerie.");
    }
  };

  // Supprimer plusieurs médias
  const deleteMultipleMedias = async () => {
    if (selectedMedias.length === 0) return;

    // Compter le nombre de vidéos et d'images
    const videoCount = selectedMedias.filter(media => media.isVideo).length;
    const imageCount = selectedMedias.length - videoCount;
    
    let messageText = '';
    if (videoCount > 0 && imageCount > 0) {
      messageText = `${imageCount} image(s) et ${videoCount} vidéo(s)`;
    } else if (videoCount > 0) {
      messageText = `${videoCount} vidéo(s)`;
    } else {
      messageText = `${imageCount} image(s)`;
    }

    Alert.alert(
      "Confirmation",
      `Êtes-vous sûr de vouloir supprimer ${messageText} ?`,
      [
        { text: "Annuler", style: "cancel" },
        { 
          text: "Supprimer", 
          style: "destructive",
          onPress: async () => {
            try {
              let deletedCount = 0;
              const fileNamesToDelete = selectedMedias.map(media => media.fileName);
              
              for (const media of selectedMedias) {
                try {
                  await FileSystem.deleteAsync(media.uri, { idempotent: true });
                  deletedCount++;
                } catch (e) {
                  console.error(`Erreur lors de la suppression de ${media.fileName}:`, e);
                }
              }
              
              if (deletedCount > 0) {
                // Mettre à jour la liste de médias
                setMedias(medias.filter(media => !fileNamesToDelete.includes(media.fileName)));
                
                let message = '';
                if (Platform.OS === 'android') {
                  ToastAndroid.show(`${deletedCount} média(s) supprimé(s)`, ToastAndroid.LONG);
                } else {
                  Alert.alert("Succès", `${deletedCount} média(s) supprimé(s).`);
                }
                exitSelectionMode();
              }
            } catch (error) {
              console.error("Erreur lors de la suppression multiple:", error);
              Alert.alert("Erreur", "Impossible de supprimer certains médias.");
            }
          } 
        }
      ]
    );
  };

  // Activer le mode sélection
  const toggleSelectionMode = () => {
    if (selectionMode) {
      exitSelectionMode();
    } else {
      setSelectionMode(true);
    }
  };

  // Désactiver le mode sélection
  const exitSelectionMode = () => {
    setSelectionMode(false);
    setSelectedMedias([]);
  };

  // Sélectionner/désélectionner un média
  const toggleMediaSelection = (media: DownloadedMedia) => {
    if (selectedMedias.some(m => m.fileName === media.fileName)) {
      setSelectedMedias(selectedMedias.filter(m => m.fileName !== media.fileName));
    } else {
      setSelectedMedias([...selectedMedias, media]);
    }
  };

  // Afficher les options pour un média
  const showMediaOptions = (media: DownloadedMedia) => {
    const mediaType = media.isVideo ? "vidéo" : "image";
    Alert.alert(
      "Options",
      `Que souhaitez-vous faire avec cette ${mediaType} ?`,
      [
        { text: "Annuler", style: "cancel" },
        { text: "Sauvegarder dans la galerie", onPress: () => saveToGallery(media.uri, media.isVideo) },
        { text: "Partager", onPress: () => shareMedia(media.uri, media.isVideo) },
        { text: "Supprimer", onPress: () => deleteMedia(media.uri, media.fileName, media.isVideo), style: "destructive" }
      ]
    );
  };

  // Afficher les options pour les médias sélectionnés
  const showMultipleMediaOptions = () => {
    if (selectedMedias.length === 0) return;
    
    // Compter le nombre de vidéos et d'images
    const videoCount = selectedMedias.filter(media => media.isVideo).length;
    const imageCount = selectedMedias.length - videoCount;
    
    let title = '';
    if (videoCount > 0 && imageCount > 0) {
      title = `${imageCount} image(s) et ${videoCount} vidéo(s) sélectionnée(s)`;
    } else if (videoCount > 0) {
      title = `${videoCount} vidéo(s) sélectionnée(s)`;
    } else {
      title = `${imageCount} image(s) sélectionnée(s)`;
    }
    
    Alert.alert(
      title,
      "Que souhaitez-vous faire avec ces médias ?",
      [
        { text: "Annuler", style: "cancel" },
        { text: "Sauvegarder dans la galerie", onPress: saveMultipleToGallery },
        { text: "Partager", onPress: shareMultipleMedias },
        { text: "Supprimer", onPress: deleteMultipleMedias, style: "destructive" }
      ]
    );
  };

  const renderMediaItem = ({ item }: { item: DownloadedMedia }) => {
    const isSelected = selectedMedias.some(media => media.fileName === item.fileName);
    
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
          // Rendu pour les vidéos
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
          // Rendu pour les images
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
      <Stack.Screen
        options={{
          title: selectionMode 
            ? `${selectedMedias.length} élément(s) sélectionné(s)` 
            : 'Médias téléchargés',
          headerShown: true,
          headerRight: selectionMode ? () => (
            <View style={{ flexDirection: 'row' }}>
              <TouchableOpacity
                onPress={showMultipleMediaOptions}
                style={{ marginRight: 15 }}
                disabled={selectedMedias.length === 0}
              >
                <Ionicons 
                  name="ellipsis-vertical-circle" 
                  size={24} 
                  color={selectedMedias.length > 0 ? Colors[colorScheme ?? 'light'].tint : '#ccc'} 
                />
              </TouchableOpacity>
              <TouchableOpacity onPress={exitSelectionMode} style={{ marginRight: 10 }}>
                <Ionicons name="close-circle" size={24} color={Colors[colorScheme ?? 'light'].tint} />
              </TouchableOpacity>
            </View>
          ) : undefined
        }}
      />

      {loading ? (
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color={Colors[colorScheme ?? 'light'].tint} />
          <Text style={styles.loadingText}>Chargement des médias...</Text>
        </View>
      ) : medias.length > 0 ? (
        <>
          <FlatList
            data={medias}
            renderItem={renderMediaItem}
            keyExtractor={item => item.fileName}
            numColumns={2}
            contentContainerStyle={styles.mediaList}
          />
          
          {/* Bouton de sélection multiple très visible */}
          {!selectionMode && medias.length > 1 && (
            <TouchableOpacity 
              style={styles.selectButton} 
              onPress={toggleSelectionMode}
            >
              <Ionicons name="checkmark-circle" size={24} color="white" />
              <Text style={styles.selectButtonText}>Sélectionner</Text>
            </TouchableOpacity>
          )}
          
          {/* Actions pour les médias sélectionnés */}
          {selectionMode && selectedMedias.length > 0 && (
            <View style={styles.actionBar}>
              <TouchableOpacity 
                style={styles.actionButton} 
                onPress={saveMultipleToGallery}>
                <Ionicons name="download" size={22} color="white" />
                <Text style={styles.actionButtonText}>Sauvegarder</Text>
              </TouchableOpacity>
              
              <TouchableOpacity 
                style={styles.actionButton} 
                onPress={shareMultipleMedias}>
                <Ionicons name="share-social" size={22} color="white" />
                <Text style={styles.actionButtonText}>Partager</Text>
              </TouchableOpacity>
              
              <TouchableOpacity 
                style={[styles.actionButton, styles.deleteButton]} 
                onPress={deleteMultipleMedias}>
                <Ionicons name="trash" size={22} color="white" />
                <Text style={styles.actionButtonText}>Supprimer</Text>
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
  selectButton: {
    position: 'absolute',
    right: 100,
    bottom: 100,
    backgroundColor: '#FF5722',
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 30,
    elevation: 10,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.4,
    shadowRadius: 5,
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 2,
    borderColor: 'white',
  },
  selectButtonText: {
    color: 'white',
    fontWeight: 'bold',
    fontSize: 16,
    marginLeft: 8,
    textShadowColor: 'rgba(0, 0, 0, 0.2)',
    textShadowOffset: { width: 1, height: 1 },
    textShadowRadius: 1,
  },
  actionBar: {
    flexDirection: 'row',
    justifyContent: 'space-evenly',
    alignItems: 'center',
    backgroundColor: '#f0f0f0',
    paddingVertical: 12,
    borderTopWidth: 1,
    borderTopColor: '#ddd',
  },
  actionButton: {
    backgroundColor: '#2196F3',
    paddingHorizontal: 15,
    paddingVertical: 10,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    elevation: 3,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 2,
  },
  actionButtonText: {
    color: 'white',
    fontWeight: 'bold',
    marginLeft: 6,
    fontSize: 14,
  },
  deleteButton: {
    backgroundColor: '#F44336',
  },
});
