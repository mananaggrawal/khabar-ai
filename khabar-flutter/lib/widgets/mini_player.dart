import 'package:audio_service/audio_service.dart';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../providers/player_provider.dart';
import '../utils/section_meta.dart';

class MiniPlayer extends StatelessWidget {
  const MiniPlayer({super.key});

  @override
  Widget build(BuildContext context) {
    final player = context.watch<PlayerProvider>();
    if (!player.playerVisible) return const SizedBox.shrink();

    final story = player.currentStory;
    if (story == null) return const SizedBox.shrink();

    final meta = SectionMeta.of(story.section);

    return GestureDetector(
      onTap: () => Navigator.of(context).pushNamed('/player'),
      child: Container(
        margin: const EdgeInsets.fromLTRB(12, 0, 12, 8),
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
        decoration: BoxDecoration(
          color: const Color(0xFF1E1E1E),
          borderRadius: BorderRadius.circular(16),
          border: Border.all(color: meta.color.withOpacity(0.4)),
          boxShadow: [
            BoxShadow(
              color: Colors.black.withOpacity(0.4),
              blurRadius: 12,
              offset: const Offset(0, 4),
            ),
          ],
        ),
        child: Row(
          children: [
            // Color dot
            Container(
              width: 8,
              height: 8,
              decoration: BoxDecoration(
                color: meta.color,
                shape: BoxShape.circle,
              ),
            ),
            const SizedBox(width: 10),
            // Title
            Expanded(
              child: Text(
                story.title,
                style: const TextStyle(
                  color: Colors.white,
                  fontSize: 13,
                  fontWeight: FontWeight.w500,
                ),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
            ),
            const SizedBox(width: 8),
            // Progress indicator
            StreamBuilder<PlaybackState>(
              stream: player.handler.playbackState,
              builder: (context, snapshot) {
                final state = snapshot.data;
                final isBuffering = state?.processingState ==
                    AudioProcessingState.buffering;
                if (isBuffering) {
                  return const SizedBox(
                    width: 24,
                    height: 24,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  );
                }
                return IconButton(
                  icon: Icon(
                    player.isPlaying ? Icons.pause : Icons.play_arrow,
                    color: Colors.white,
                  ),
                  onPressed: player.togglePlayPause,
                  padding: EdgeInsets.zero,
                  constraints: const BoxConstraints(),
                );
              },
            ),
            const SizedBox(width: 4),
            IconButton(
              icon: const Icon(Icons.skip_next, color: Colors.white70),
              onPressed: player.skipNext,
              padding: EdgeInsets.zero,
              constraints: const BoxConstraints(),
            ),
          ],
        ),
      ),
    );
  }
}
