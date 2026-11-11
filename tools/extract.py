# 用和 App 相同的 pose_landmarker_lite 模型，逐幀取出關節點（2D 正規化座標 + 3D 世界座標）
import sys, json, cv2, mediapipe as mp
from mediapipe.tasks.python import vision, BaseOptions
model, video, out = sys.argv[1:4]
opts = vision.PoseLandmarkerOptions(base_options=BaseOptions(model_asset_path=model),
                                    running_mode=vision.RunningMode.VIDEO, num_poses=1)
cap = cv2.VideoCapture(video)
fps = cap.get(cv2.CAP_PROP_FPS) or 30
W, H = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)), int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
frames = []
with vision.PoseLandmarker.create_from_options(opts) as lmk:
    i = 0
    while True:
        ok, img = cap.read()
        if not ok: break
        rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
        res = lmk.detect_for_video(mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb), int(i * 1000 / fps))
        if res.pose_landmarks:
            l = [[round(p.x, 5), round(p.y, 5), round(p.z, 5), round(p.visibility, 3)] for p in res.pose_landmarks[0]]
            w = [[round(p.x, 5), round(p.y, 5), round(p.z, 5)] for p in res.pose_world_landmarks[0]]
            frames.append({'t': round(i * 1000 / fps, 1), 'l': l, 'w': w})
        else:
            frames.append({'t': round(i * 1000 / fps, 1)})
        i += 1
json.dump({'video': video.split('/')[-1], 'fps': fps, 'width': W, 'height': H, 'frames': frames}, open(out, 'w'))
print(video.split('/')[-1], len(frames))
