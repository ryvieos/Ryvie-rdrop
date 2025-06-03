import { Tabs } from 'expo-router';
import React from 'react';
import { Platform } from 'react-native';

import { HapticTab } from '@/components/HapticTab';
import { IconSymbol } from '@/components/ui/IconSymbol';
import TabBarBackground from '@/components/ui/TabBarBackground';
import { Colors } from '@/constants/Colors';
import { useColorScheme } from '@/hooks/useColorScheme';

export default function TabLayout() {
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';

  return (
    <Tabs
      initialRouteName="webview"
      screenOptions={{
        tabBarActiveTintColor: isDark ? Colors.dark.tint : Colors.light.tint,
        tabBarInactiveTintColor: isDark ? Colors.dark.tabIconDefault : Colors.light.tabIconDefault,
        headerShown: false,
        tabBarButton: HapticTab,
        tabBarBackground: () => null,
        tabBarStyle: {
          backgroundColor: isDark ? Colors.dark.background : Colors.light.background,
          borderTopColor: isDark ? '#2D2F30' : '#E6E8EB',
          borderTopWidth: 1,
          height: 80,
          paddingBottom: 8,
          paddingTop: 8,
        },
        tabBarLabelStyle: {
          fontSize: 13,
          fontWeight: '700',
        },
      }}>

      <Tabs.Screen
        name="webview"
        options={{
          title: 'Web',
          tabBarIcon: ({ color }) => <IconSymbol size={32} name="globe" color={color} />,
        }}
      />
      <Tabs.Screen
        name="downloads"
        options={{
          title: 'Téléchargements',
          tabBarIcon: ({ color }) => <IconSymbol size={32} name="arrow.down.circle.fill" color={color} />,
        }}
      />
    </Tabs>
  );
}