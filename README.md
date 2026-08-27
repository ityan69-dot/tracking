# AI Object Detector

Real-time browser object detection powered by YOLO11n and ONNX Runtime Web.

## Run

Camera access requires localhost or HTTPS:

```powershell
npx.cmd serve .
```

Open the localhost address printed in the terminal and allow camera access. The first load needs internet access for ONNX Runtime. The YOLO model is stored locally at `models/yolo11n.onnx`.

## Scope

- Uses YOLO11n to detect the 80 object categories supported by COCO.
- Detects up to 20 objects in one frame and shows a bounding box, name, and confidence.
- Stabilizes object boxes across frames to reduce flicker during multi-object detection.
- Runs in the browser; this project does not upload camera frames.
