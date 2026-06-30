import 'package:flutter/material.dart';

class SectionMeta {
  final Color color;
  final IconData icon;
  final String label;

  const SectionMeta({
    required this.color,
    required this.icon,
    required this.label,
  });

  static SectionMeta of(String section) {
    return _map[section] ?? _map['headlines']!;
  }

  static final _map = <String, SectionMeta>{
    'headlines': SectionMeta(
      color: const Color(0xFFEF4444),
      icon: Icons.local_fire_department,
      label: 'Headlines',
    ),
    'india': SectionMeta(
      color: const Color(0xFFF97316),
      icon: Icons.account_balance,
      label: 'India',
    ),
    'world': SectionMeta(
      color: const Color(0xFF0D9488),
      icon: Icons.language,
      label: 'World',
    ),
    'business': SectionMeta(
      color: const Color(0xFF16A34A),
      icon: Icons.trending_up,
      label: 'Business',
    ),
    'local': SectionMeta(
      color: const Color(0xFF2563EB),
      icon: Icons.location_on,
      label: 'Local',
    ),
  };

  static List<String> get orderedKeys =>
      ['headlines', 'india', 'world', 'business', 'local'];
}
