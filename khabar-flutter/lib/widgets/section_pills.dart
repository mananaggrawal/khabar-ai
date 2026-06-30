import 'package:flutter/material.dart';
import '../utils/section_meta.dart';

class SectionPills extends StatelessWidget {
  final List<String> sections;
  final String active;
  final ValueChanged<String> onTap;

  const SectionPills({
    super.key,
    required this.sections,
    required this.active,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      height: 40,
      child: ListView.separated(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.symmetric(horizontal: 16),
        itemCount: sections.length,
        separatorBuilder: (_, __) => const SizedBox(width: 8),
        itemBuilder: (context, i) {
          final section = sections[i];
          final meta = SectionMeta.of(section);
          final isActive = section == active;
          return GestureDetector(
            onTap: () => onTap(section),
            child: AnimatedContainer(
              duration: const Duration(milliseconds: 200),
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
              decoration: BoxDecoration(
                color: isActive ? meta.color : const Color(0xFF1A1A1A),
                borderRadius: BorderRadius.circular(20),
              ),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Icon(
                    meta.icon,
                    size: 14,
                    color: isActive ? Colors.white : Colors.white38,
                  ),
                  const SizedBox(width: 5),
                  Text(
                    meta.label,
                    style: TextStyle(
                      color: isActive ? Colors.white : Colors.white38,
                      fontSize: 13,
                      fontWeight: isActive ? FontWeight.w600 : FontWeight.w400,
                    ),
                  ),
                ],
              ),
            ),
          );
        },
      ),
    );
  }
}
