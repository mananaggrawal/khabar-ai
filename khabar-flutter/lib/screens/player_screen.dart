import 'package:audio_service/audio_service.dart';
import 'package:flutter/material.dart';
import 'package:cached_network_image/cached_network_image.dart';
import 'package:provider/provider.dart';
import '../providers/player_provider.dart';
import '../utils/section_meta.dart';

class PlayerScreen extends StatelessWidget {
  const PlayerScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final player = context.watch<PlayerProvider>();
    final story = player.currentStory;

    if (story == null) {
      return Scaffold(
        backgroundColor: const Color(0xFF0A0A0A),
        appBar: AppBar(backgroundColor: Colors.transparent),
        body: const Center(
          child: Text('Nothing playing', style: TextStyle(color: Colors.white54)),
        ),
      );
    }

    final meta = SectionMeta.of(story.section);

    return Scaffold(
      backgroundColor: const Color(0xFF0A0A0A),
      appBar: AppBar(
        backgroundColor: Colors.transparent,
        leading: IconButton(
          icon: const Icon(Icons.keyboard_arrow_down, color: Colors.white, size: 28),
          onPressed: () => Navigator.of(context).pop(),
        ),
        title: Text(
          meta.label.toUpperCase(),
          style: TextStyle(
            color: meta.color,
            fontSize: 12,
            fontWeight: FontWeight.w700,
            letterSpacing: 1.5,
          ),
        ),
        centerTitle: true,
      ),
      body: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 28),
        child: Column(
          children: [
            const SizedBox(height: 16),

            // Artwork
            ClipRRect(
              borderRadius: BorderRadius.circular(20),
              child: story.imageUrl != null
                  ? CachedNetworkImage(
                      imageUrl: story.imageUrl!,
                      width: double.infinity,
                      height: 260,
                      fit: BoxFit.cover,
                      errorWidget: (_, __, ___) => _artPlaceholder(meta.color),
                    )
                  : _artPlaceholder(meta.color),
            ),
            const SizedBox(height: 28),

            // Title
            Text(
              story.title,
              style: const TextStyle(
                color: Colors.white,
                fontSize: 20,
                fontWeight: FontWeight.w700,
                height: 1.3,
              ),
              textAlign: TextAlign.center,
            ),
            const SizedBox(height: 6),
            Text(
              story.source,
              style: TextStyle(
                color: Colors.white.withOpacity(0.4),
                fontSize: 14,
              ),
            ),
            const SizedBox(height: 24),

            // Script
            Expanded(
              child: SingleChildScrollView(
                child: Text(
                  story.scriptEn,
                  style: TextStyle(
                    color: Colors.white.withOpacity(0.7),
                    fontSize: 15,
                    height: 1.6,
                  ),
                  textAlign: TextAlign.center,
                ),
              ),
            ),
            const SizedBox(height: 16),

            // Progress bar
            StreamBuilder<Duration?>(
              stream: player.handler.player.positionStream,
              builder: (context, snapshot) {
                final position = snapshot.data ?? Duration.zero;
                final duration =
                    player.handler.player.duration ?? Duration.zero;
                final progress = duration.inMilliseconds > 0
                    ? position.inMilliseconds / duration.inMilliseconds
                    : 0.0;

                return Column(
                  children: [
                    SliderTheme(
                      data: SliderTheme.of(context).copyWith(
                        trackHeight: 3,
                        thumbShape: const RoundSliderThumbShape(
                          enabledThumbRadius: 6,
                        ),
                        overlayShape: SliderComponentShape.noOverlay,
                        activeTrackColor: meta.color,
                        inactiveTrackColor: Colors.white12,
                        thumbColor: Colors.white,
                      ),
                      child: Slider(
                        value: progress.clamp(0.0, 1.0),
                        onChanged: (v) {
                          final newPos = Duration(
                            milliseconds: (v * duration.inMilliseconds).round(),
                          );
                          player.seek(newPos);
                        },
                      ),
                    ),
                    Padding(
                      padding: const EdgeInsets.symmetric(horizontal: 4),
                      child: Row(
                        mainAxisAlignment: MainAxisAlignment.spaceBetween,
                        children: [
                          Text(_fmt(position),
                              style: const TextStyle(
                                  color: Colors.white38, fontSize: 12)),
                          Text(_fmt(duration),
                              style: const TextStyle(
                                  color: Colors.white38, fontSize: 12)),
                        ],
                      ),
                    ),
                  ],
                );
              },
            ),
            const SizedBox(height: 8),

            // Controls
            StreamBuilder<PlaybackState>(
              stream: player.handler.playbackState,
              builder: (context, snapshot) {
                final isBuffering = snapshot.data?.processingState ==
                    AudioProcessingState.buffering;

                return Row(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    IconButton(
                      iconSize: 36,
                      icon: const Icon(Icons.skip_previous, color: Colors.white70),
                      onPressed: player.skipPrev,
                    ),
                    const SizedBox(width: 16),
                    GestureDetector(
                      onTap: isBuffering ? null : player.togglePlayPause,
                      child: Container(
                        width: 68,
                        height: 68,
                        decoration: BoxDecoration(
                          color: meta.color,
                          shape: BoxShape.circle,
                        ),
                        child: isBuffering
                            ? const Padding(
                                padding: EdgeInsets.all(20),
                                child: CircularProgressIndicator(
                                  strokeWidth: 2.5,
                                  color: Colors.white,
                                ),
                              )
                            : Icon(
                                player.isPlaying
                                    ? Icons.pause
                                    : Icons.play_arrow,
                                color: Colors.white,
                                size: 36,
                              ),
                      ),
                    ),
                    const SizedBox(width: 16),
                    IconButton(
                      iconSize: 36,
                      icon: const Icon(Icons.skip_next, color: Colors.white70),
                      onPressed: player.skipNext,
                    ),
                  ],
                );
              },
            ),
            const SizedBox(height: 32),
          ],
        ),
      ),
    );
  }

  Widget _artPlaceholder(Color color) {
    return Container(
      width: double.infinity,
      height: 260,
      decoration: BoxDecoration(
        color: color.withOpacity(0.12),
        borderRadius: BorderRadius.circular(20),
      ),
      child: Icon(Icons.mic, color: color.withOpacity(0.4), size: 64),
    );
  }

  String _fmt(Duration d) {
    final m = d.inMinutes.remainder(60).toString().padLeft(2, '0');
    final s = d.inSeconds.remainder(60).toString().padLeft(2, '0');
    return '$m:$s';
  }
}
