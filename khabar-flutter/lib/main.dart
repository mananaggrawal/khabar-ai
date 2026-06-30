import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:webview_flutter/webview_flutter.dart';

void main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await SystemChrome.setPreferredOrientations([DeviceOrientation.portraitUp]);
  runApp(const KhabarApp());
}

class KhabarApp extends StatelessWidget {
  const KhabarApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Khabar',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(
          seedColor: const Color(0xFF7C3AED),
          brightness: Brightness.light,
        ),
        useMaterial3: true,
      ),
      home: kIsWeb ? const _WebPlaceholder() : const KhabarWebView(),
    );
  }
}

/// Shown when running on web — the WebView only works on iOS/Android.
class _WebPlaceholder extends StatelessWidget {
  const _WebPlaceholder();

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: const Color(0xFFF0EEFF),
      body: Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Text(
              'Khabar',
              style: TextStyle(
                fontSize: 32,
                fontWeight: FontWeight.w700,
                color: Color(0xFF1A1A2E),
              ),
            ),
            const SizedBox(height: 12),
            const Text(
              'The iOS app wraps the PWA.\nOpen the link below in your browser to use the app:',
              textAlign: TextAlign.center,
              style: TextStyle(color: Color(0xFF6B7280)),
            ),
            const SizedBox(height: 20),
            SelectableText(
              'https://khabar-ai.onrender.com',
              style: const TextStyle(
                color: Color(0xFF7C3AED),
                decoration: TextDecoration.underline,
                fontSize: 16,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class KhabarWebView extends StatefulWidget {
  const KhabarWebView({super.key});

  @override
  State<KhabarWebView> createState() => _KhabarWebViewState();
}

class _KhabarWebViewState extends State<KhabarWebView> {
  late final WebViewController _controller;
  bool _loading = true;

  static const _url = 'https://khabar-ai.onrender.com';

  @override
  void initState() {
    super.initState();
    _controller = WebViewController()
      ..setJavaScriptMode(JavaScriptMode.unrestricted)
      ..setBackgroundColor(const Color(0xFFF0EEFF))
      ..setNavigationDelegate(
        NavigationDelegate(
          onPageStarted: (_) => setState(() => _loading = true),
          onPageFinished: (_) => setState(() => _loading = false),
          onWebResourceError: (error) {
            debugPrint('WebView error: ${error.description}');
          },
          // Allow all navigation within the app (OAuth redirects, etc.)
          onNavigationRequest: (request) => NavigationDecision.navigate,
        ),
      )
      ..loadRequest(Uri.parse(_url));
  }

  Future<bool> _onWillPop() async {
    if (await _controller.canGoBack()) {
      await _controller.goBack();
      return false;
    }
    return true;
  }

  @override
  Widget build(BuildContext context) {
    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (didPop, _) async {
        if (!didPop && await _controller.canGoBack()) {
          await _controller.goBack();
        }
      },
      child: Scaffold(
        backgroundColor: const Color(0xFFF0EEFF),
        body: Stack(
          children: [
            // Status bar area — match the PWA's gradient top
            SafeArea(
              child: WebViewWidget(controller: _controller),
            ),
            // Loading overlay
            if (_loading)
              const Center(
                child: CircularProgressIndicator(
                  color: Color(0xFF7C3AED),
                ),
              ),
          ],
        ),
      ),
    );
  }
}
