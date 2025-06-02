import { Redirect } from 'expo-router';

export default function Index() {
  // Rediriger vers l'onglet Web au démarrage de l'application
  return <Redirect href="/(tabs)/webview" />;
}
