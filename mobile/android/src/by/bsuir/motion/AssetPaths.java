package by.bsuir.motion;

/** Map an already URL-decoded request path to one APK asset, without traversal. */
public final class AssetPaths {
    private AssetPaths() {}
    public static String relative(String path) {
        if(path==null||path.indexOf('\0')>=0||path.contains(".."))return null;
        String normalized=path.replaceAll("/+","/");
        if(!normalized.startsWith("/assets/")||normalized.length()==8)return null;
        return normalized.substring(8);
    }
}
