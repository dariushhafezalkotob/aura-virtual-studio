import sys
import os
import math
import numpy as np
from PIL import Image

def extract_perspective(img_np, yaw_deg, fov_deg=90.0, width=512, height=512):
    h, w, _ = img_np.shape
    yaw = math.radians(yaw_deg)
    fov = math.radians(fov_deg)
    
    f = 0.5 * width / math.tan(fov / 2.0)
    
    x = np.linspace(-width / 2.0, width / 2.0, width)
    y = np.linspace(-height / 2.0, height / 2.0, height)
    xx, yy = np.meshgrid(x, y)
    
    # Ray in camera frame
    cx = xx
    cy = -yy
    cz = np.full_like(xx, f)
    
    # Rotate by yaw around Y axis
    rx = cx * math.cos(yaw) + cz * math.sin(yaw)
    ry = cy
    rz = -cx * math.sin(yaw) + cz * math.cos(yaw)
    
    norm = np.sqrt(rx**2 + ry**2 + rz**2)
    rx /= norm
    ry /= norm
    rz /= norm
    
    theta = np.arctan2(rx, rz)
    phi = np.arcsin(np.clip(ry, -1.0, 1.0))
    
    u = np.clip((theta / (2.0 * math.pi) + 0.5) * (w - 1), 0, w - 1).astype(int)
    v = np.clip((0.5 - phi / math.pi) * (h - 1), 0, h - 1).astype(int)
    
    perspective_rgb = img_np[v, u]
    return Image.fromarray(perspective_rgb)

def slice_360_to_4_views(pano_path, output_dir):
    os.makedirs(output_dir, exist_ok=True)
    img = Image.open(pano_path).convert('RGB')
    img_np = np.array(img)
    
    views = {
        'slice_front.png': 0.0,
        'slice_right.png': 90.0,
        'slice_back.png': 180.0,
        'slice_left.png': 270.0
    }
    
    for filename, yaw in views.items():
        out_img = extract_perspective(img_np, yaw, fov_deg=90.0, width=512, height=512)
        out_img.save(os.path.join(output_dir, filename))
        
    print(f"Successfully sliced 360 panorama into 4 perspective views in {output_dir}")

if __name__ == '__main__':
    if len(sys.argv) < 3:
        print("Usage: slice_equirect_views.py <input_360_image> <output_dir>")
        sys.exit(1)
    slice_360_to_4_views(sys.argv[1], sys.argv[2])
