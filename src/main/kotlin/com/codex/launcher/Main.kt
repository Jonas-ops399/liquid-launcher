package com.codex.launcher

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.spring
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.SingleWindowApplication
import com.codex.launcher.ui.design.GlassButton
import com.codex.launcher.ui.design.GlassColors
import com.codex.launcher.ui.design.GlassMotion
import com.codex.launcher.ui.design.GlassPanel
import com.codex.launcher.ui.design.GlassShapes
import com.codex.launcher.ui.design.GlassSurface
import com.codex.launcher.ui.design.GlassTypography
import com.codex.launcher.ui.scene.SceneCrossFade
import com.codex.launcher.ui.scene.SceneDefinition
import com.codex.launcher.ui.scene.SceneRegistry
import com.codex.launcher.ui.scene.SceneView
import com.codex.launcher.ui.scene.VolcanoScene
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

/**
 * Better Client Launcher - Main Entry Point
 *
 * Liquid Glass Launcher with animated scene presets
 * Focus: Schematics & Base Finding (SusChunk)
 */
@Composable
fun LauncherApp() {
    // Initialize scenes
    remember { SceneRegistry.loadBuiltIns() }

    val currentScene by remember { mutableStateOf<SceneDefinition?>(null) }
    val previousScene by remember { mutableStateOf<SceneDefinition?>(null) }
    val crossFadeProgress by remember { mutableStateOf(1f) }
    val isTransitioning by remember { mutableStateOf(false) }

    // Animated cross-fade progress using Compose animation
    val animatedProgress = remember {
        androidx.compose.animation.core.animateFloatAsState(
            targetValue = crossFadeProgress,
            animationSpec = com.codex.launcher.ui.design.GlassMotion.SpecSceneTransition,
            label = "sceneCrossFade"
        )
    }

    // Load volcano as default scene
    androidx.compose.runtime.LaunchedEffect(Unit) {
        val volcano = SceneRegistry.get("volcano")
        if (volcano != null) {
            currentScene = volcano
        }
    }

    // Scene transition function
    val switchScene = remember { (scene: SceneDefinition) -> {
        if (isTransitioning || currentScene?.id == scene.id) return@launch
        isTransitioning = true
        previousScene = currentScene
        crossFadeProgress = 0f // This will trigger animatedProgress animation

        // Wait for animation to complete, then swap scenes
        androidx.compose.runtime.LaunchedEffect(crossFadeProgress) {
            if (crossFadeProgress == 0f) {
                // Wait for animation to reach ~0.99
                while (animatedProgress.value < 0.99f) {
                    kotlinx.coroutines.delay(16)
                }
                currentScene = scene
                previousScene = null
                crossFadeProgress = 1f
                isTransitioning = false
            }
        }
    }}

    Box(modifier = Modifier.fillMaxSize()) {
        // Background Scene Layer
        if (currentScene != null) {
            SceneView(
                modifier = Modifier.fillMaxSize(),
                scene = currentScene!!,
                crossFadeProgress = animatedProgress.value,
                previousScene = previousScene,
            )
        } else {
            // Fallback gradient
            Box(
                modifier = Modifier.fillMaxSize()
                    .background(
                        androidx.compose.ui.graphics.Brush.verticalGradient(
                            colors = listOf(
                                GlassColors.SceneFallbackGradientStart,
                                GlassColors.SceneFallbackGradientEnd,
                            )
                        )
                    )
            )
        }

        // Glass UI Layer
        Column(
            modifier = Modifier.fillMaxSize(),
            verticalArrangement = Arrangement.Center,
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            // Hero Play Button
            GlassButton(
                modifier = Modifier.size(280.dp, 64.dp),
                onClick = { println("🎮 Play clicked - would launch Minecraft") },
            ) {
                Text(
                    text = "Spielen",
                    style = GlassTypography.HeroButton.onAccent(),
                )
            }

            // Version info (tiny pixel accent)
            androidx.compose.foundation.layout.Spacer(modifier = Modifier.padding(top = 24.dp))
            Text(
                text = "Better Client Launcher • v1.0.0-dev • 1.21.11",
                style = GlassTypography.PixelTiny.onTertiary(),
            )
        }

        // Debug: Scene selector (top-right)
        GlassPanel(
            modifier = Modifier
                .padding(16.dp)
                .align(Alignment.TopEnd),
            elevation = com.codex.launcher.ui.design.GlassElevation.Level2,
        ) {
            Column {
                Text("Scene Debug", style = GlassTypography.LabelMedium.onPrimary())
                androidx.compose.foundation.layout.Spacer(modifier = Modifier.padding(8.dp))
                GlassButton(
                    modifier = Modifier.fillMaxWidth().padding(bottom = 4.dp),
                    onClick = {
                        SceneRegistry.get("volcano")?.let { switchScene(it) }
                    },
                    backgroundOpacity = 0.10f,
                ) {
                    Text("Vulkan", style = GlassTypography.LabelMedium.onPrimary())
                }
            }
        }
    }
}

fun main() = SingleWindowApplication(
    title = "Better Client Launcher",
    width = 1280,
    height = 800,
    isResizable = true,
    icon = null, // TODO: add app icon
) {
    LauncherApp()
}