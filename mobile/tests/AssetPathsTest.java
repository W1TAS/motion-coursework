package by.bsuir.motion;
public class AssetPathsTest {
    private static void expect(String path,String expected){
        String actual=AssetPaths.relative(path);
        if(expected==null?actual!=null:!expected.equals(actual))throw new AssertionError(path+" -> "+actual);
    }
    public static void main(String[] args){
        expect("/assets/vendor/wasm//vision_wasm_module_internal.js","vendor/wasm/vision_wasm_module_internal.js");
        expect("/assets/vendor/wasm/vision_wasm_module_internal.wasm","vendor/wasm/vision_wasm_module_internal.wasm");
        expect("/assets//vendor///pose_landmarker_lite.task","vendor/pose_landmarker_lite.task");
        expect("/assets/index.html","index.html");
        expect("/assets/../android/AndroidManifest.xml",null);
        expect("/assets/vendor/../wasm/file.js",null);
        expect("/other/file.js",null);expect("/assets/",null);expect(null,null);
        expect("/assets/bad\0name",null);
        System.out.println("10 Android asset path checks passed");
    }
}
