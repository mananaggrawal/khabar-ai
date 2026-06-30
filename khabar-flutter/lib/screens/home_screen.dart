import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:provider/provider.dart';
import '../providers/briefing_provider.dart';
import '../providers/player_provider.dart';
import '../services/auth_service.dart';
import '../widgets/mini_player.dart';
import '../widgets/section_pills.dart';
import '../widgets/story_card.dart';

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key});

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      context.read<BriefingProvider>().load();
    });
  }

  @override
  Widget build(BuildContext context) {
    final bp = context.watch<BriefingProvider>();
    final player = context.watch<PlayerProvider>();
    final auth = AuthService();

    return Scaffold(
      backgroundColor: const Color(0xFF0A0A0A),
      body: SafeArea(
        child: Column(
          children: [
            // Header
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 16, 16, 8),
              child: Row(
                children: [
                  Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      const Text(
                        'Khabar',
                        style: TextStyle(
                          color: Colors.white,
                          fontSize: 28,
                          fontWeight: FontWeight.w700,
                          letterSpacing: -0.5,
                        ),
                      ),
                      if (bp.briefing != null)
                        Text(
                          _formatDate(bp.briefing!.date),
                          style: TextStyle(
                            color: Colors.white.withOpacity(0.4),
                            fontSize: 13,
                          ),
                        ),
                    ],
                  ),
                  const Spacer(),
                  // Refresh
                  if (bp.status != BriefingStatus.loading)
                    IconButton(
                      icon: const Icon(Icons.refresh, color: Colors.white54),
                      onPressed: () => bp.load(),
                    ),
                  // Sign out
                  IconButton(
                    icon: const Icon(Icons.logout, color: Colors.white54),
                    onPressed: () => auth.signOut(),
                  ),
                ],
              ),
            ),

            // Section pills
            if (bp.briefing != null) ...[
              SectionPills(
                sections: bp.briefing!.sections,
                active: bp.activeSection,
                onTap: bp.setSection,
              ),
              const SizedBox(height: 8),
            ],

            // Body
            Expanded(
              child: _buildBody(context, bp, player),
            ),

            // Mini player
            const MiniPlayer(),
          ],
        ),
      ),
    );
  }

  Widget _buildBody(
    BuildContext context,
    BriefingProvider bp,
    PlayerProvider player,
  ) {
    switch (bp.status) {
      case BriefingStatus.loading:
        return const Center(
          child: CircularProgressIndicator(color: Colors.white24),
        );
      case BriefingStatus.error:
        return Center(
          child: Padding(
            padding: const EdgeInsets.all(32),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  bp.error ?? 'Something went wrong',
                  style: TextStyle(
                    color: Colors.white.withOpacity(0.6),
                    fontSize: 15,
                  ),
                  textAlign: TextAlign.center,
                ),
                const SizedBox(height: 20),
                TextButton(
                  onPressed: bp.load,
                  child: const Text('Try again'),
                ),
              ],
            ),
          ),
        );
      case BriefingStatus.ready:
        final stories = bp.activeStories;
        if (stories.isEmpty) {
          return Center(
            child: Text(
              'No stories in this section',
              style: TextStyle(color: Colors.white.withOpacity(0.4)),
            ),
          );
        }
        return ListView.builder(
          padding: const EdgeInsets.only(bottom: 16),
          itemCount: stories.length,
          itemBuilder: (context, i) {
            final story = stories[i];
            final isPlaying =
                player.currentStory?.id == story.id && player.isPlaying;
            return StoryCard(
              story: story,
              isPlaying: isPlaying,
              onTap: () async {
                if (story.audioUrlEn == null) {
                  ScaffoldMessenger.of(context).showSnackBar(
                    const SnackBar(content: Text('Audio not available yet')),
                  );
                  return;
                }
                await player.playFrom(stories, i);
                if (context.mounted) {
                  Navigator.of(context).pushNamed('/player');
                }
              },
            );
          },
        );
      case BriefingStatus.idle:
        return const SizedBox.shrink();
    }
  }

  String _formatDate(String dateStr) {
    try {
      final dt = DateTime.parse(dateStr);
      return DateFormat('EEEE, d MMM').format(dt);
    } catch (_) {
      return dateStr;
    }
  }
}
