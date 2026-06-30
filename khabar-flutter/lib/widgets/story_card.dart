import 'package:flutter/material.dart';
import 'package:cached_network_image/cached_network_image.dart';
import '../models/briefing.dart';
import '../utils/section_meta.dart';

class StoryCard extends StatelessWidget {
  final Story story;
  final bool isPlaying;
  final VoidCallback onTap;

  const StoryCard({
    super.key,
    required this.story,
    required this.isPlaying,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final meta = SectionMeta.of(story.section);

    return GestureDetector(
      onTap: onTap,
      child: Container(
        margin: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
        decoration: BoxDecoration(
          color: isPlaying
              ? meta.color.withOpacity(0.15)
              : const Color(0xFF1A1A1A),
          borderRadius: BorderRadius.circular(14),
          border: isPlaying
              ? Border.all(color: meta.color.withOpacity(0.6), width: 1.5)
              : null,
        ),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // Image
            if (story.imageUrl != null)
              ClipRRect(
                borderRadius: const BorderRadius.only(
                  topLeft: Radius.circular(14),
                  bottomLeft: Radius.circular(14),
                ),
                child: CachedNetworkImage(
                  imageUrl: story.imageUrl!,
                  width: 90,
                  height: 90,
                  fit: BoxFit.cover,
                  errorWidget: (_, __, ___) => _placeholder(meta.color),
                ),
              )
            else
              _placeholder(meta.color),
            // Text
            Expanded(
              child: Padding(
                padding: const EdgeInsets.all(12),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      story.title,
                      style: const TextStyle(
                        color: Colors.white,
                        fontSize: 14,
                        fontWeight: FontWeight.w600,
                        height: 1.3,
                      ),
                      maxLines: 3,
                      overflow: TextOverflow.ellipsis,
                    ),
                    const SizedBox(height: 6),
                    Text(
                      story.source,
                      style: TextStyle(
                        color: Colors.white.withOpacity(0.4),
                        fontSize: 12,
                      ),
                    ),
                  ],
                ),
              ),
            ),
            // Play icon
            Padding(
              padding: const EdgeInsets.all(12),
              child: Icon(
                isPlaying ? Icons.pause_circle_filled : Icons.play_circle_filled,
                color: isPlaying ? meta.color : Colors.white24,
                size: 28,
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _placeholder(Color color) {
    return Container(
      width: 90,
      height: 90,
      decoration: BoxDecoration(
        color: color.withOpacity(0.2),
        borderRadius: const BorderRadius.only(
          topLeft: Radius.circular(14),
          bottomLeft: Radius.circular(14),
        ),
      ),
      child: Icon(Icons.article_outlined, color: color.withOpacity(0.5), size: 32),
    );
  }
}
