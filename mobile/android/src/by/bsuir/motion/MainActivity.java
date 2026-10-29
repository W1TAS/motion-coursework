package by.bsuir.motion;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.ActivityNotFoundException;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.*;
import android.view.WindowManager;
import java.io.*;
import java.util.*;

/** Local HTTPS assets keep camera, WASM and model entirely within the APK. */
public class MainActivity extends Activity {
    private static final String HOST="appassets.androidplatform.net";
    private WebView web;
    private PermissionRequest cameraRequest;
    private ValueCallback<Uri[]> videoFileRequest;
    private static final int PICK_VIDEO=12;
    private boolean foreground;
    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        web=new WebView(this);
        web.setBackgroundColor(0xfff3f4f5);
        WebSettings s=web.getSettings();
        s.setJavaScriptEnabled(true);s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);s.setAllowContentAccess(true);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        web.setWebViewClient(new WebViewClient(){
            @Override public boolean shouldOverrideUrlLoading(WebView view,WebResourceRequest r){
                return !isLocal(r.getUrl());
            }
            @Override public WebResourceResponse shouldInterceptRequest(WebView view,WebResourceRequest r){
                Uri u=r.getUrl();
                if(!isLocal(u))return response(403,"Forbidden","text/plain",new byte[0]);
                String path=AssetPaths.relative(u.getPath());
                if(path==null)return response(404,"Not Found","text/plain",new byte[0]);
                try {
                    // AssetLoader-equivalent mapping: no file:// privileges, no network fallback.
                    InputStream input=getAssets().open(path);
                    String mime=path.endsWith(".mjs")||path.endsWith(".js")?"text/javascript":path.endsWith(".wasm")?"application/wasm":path.endsWith(".mp4")?"video/mp4":path.endsWith(".txt")?"text/plain":path.endsWith(".task")?"application/octet-stream":path.endsWith(".css")?"text/css":path.endsWith(".svg")?"image/svg+xml":path.endsWith(".json")?"application/json":"text/html";
                    Map<String,String> headers=new HashMap<>();
                    headers.put("Cache-Control","no-cache");
                    headers.put("X-Content-Type-Options","nosniff");
                    int length=input.available();
                    headers.put("Content-Length",String.valueOf(length));
                    if("video/mp4".equals(mime)){
                        headers.put("Accept-Ranges","bytes");
                        String range=r.getRequestHeaders().get("Range");
                        if(range==null)range=r.getRequestHeaders().get("range");
                        if(range!=null&&range.matches("bytes=[0-9]+-[0-9]*")){
                            String[] parts=range.substring(6).split("-",-1);
                            int start=Integer.parseInt(parts[0]);
                            int end=parts[1].isEmpty()?length-1:Math.min(length-1,Integer.parseInt(parts[1]));
                            if(start<0||start>=length||end<start){input.close();return response(416,"Range Not Satisfiable","text/plain",new byte[0]);}
                            ByteArrayOutputStream bytes=new ByteArrayOutputStream();byte[] buffer=new byte[8192];int read;
                            while((read=input.read(buffer))!=-1)bytes.write(buffer,0,read);
                            input.close();
                            headers.put("Content-Range","bytes "+start+"-"+end+"/"+length);
                            headers.put("Content-Length",String.valueOf(end-start+1));
                            return new WebResourceResponse(mime,null,206,"Partial Content",headers,new ByteArrayInputStream(bytes.toByteArray(),start,end-start+1));
                        }
                    }
                    return new WebResourceResponse(mime,mime.startsWith("text/")?"UTF-8":null,200,"OK",headers,input);
                }catch(IOException|NumberFormatException e){return response(404,"Not Found","text/plain",new byte[0]);}
            }
        });
        web.setWebChromeClient(new WebChromeClient(){
            @Override public boolean onShowFileChooser(WebView view,ValueCallback<Uri[]> callback,FileChooserParams params){
                if(!foreground||view.getUrl()==null||!isLocal(Uri.parse(view.getUrl())))return false;
                if(videoFileRequest!=null)videoFileRequest.onReceiveValue(null);
                videoFileRequest=callback;
                // A user-selected document grant; no broad photo/storage permission.
                Intent pick=new Intent(Intent.ACTION_OPEN_DOCUMENT);
                pick.addCategory(Intent.CATEGORY_OPENABLE);
                pick.setType("video/*");pick.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                try{startActivityForResult(pick,PICK_VIDEO);}
                catch(ActivityNotFoundException e){videoFileRequest=null;callback.onReceiveValue(null);}
                return true;
            }
            @Override public void onPermissionRequest(PermissionRequest request){
                runOnUiThread(()->{
                    if(!foreground||!isLocal(request.getOrigin())||!Arrays.asList(request.getResources()).contains(PermissionRequest.RESOURCE_VIDEO_CAPTURE)){request.deny();return;}
                    if(cameraRequest!=null)cameraRequest.deny();
                    if(checkSelfPermission(Manifest.permission.CAMERA)==PackageManager.PERMISSION_GRANTED){request.grant(new String[]{PermissionRequest.RESOURCE_VIDEO_CAPTURE});}
                    else {cameraRequest=request;requestPermissions(new String[]{Manifest.permission.CAMERA},11);}
                });
            }
            @Override public void onPermissionRequestCanceled(PermissionRequest request){if(cameraRequest==request)cameraRequest=null;}
        });
        setContentView(web);
        // Insets remain outside the WebView even on target API 35 edge-to-edge defaults.
        web.setOnApplyWindowInsetsListener((v,insets)->{v.setPadding(insets.getSystemWindowInsetLeft(),insets.getSystemWindowInsetTop(),insets.getSystemWindowInsetRight(),insets.getSystemWindowInsetBottom());return insets.consumeSystemWindowInsets();});
        web.loadUrl("https://"+HOST+"/assets/index.html");
    }
    private boolean isLocal(Uri uri){return "https".equals(uri.getScheme())&&HOST.equals(uri.getHost())&&uri.getPort()==-1;}
    private WebResourceResponse response(int code,String reason,String mime,byte[] data){return new WebResourceResponse(mime,"UTF-8",code,reason,Collections.emptyMap(),new ByteArrayInputStream(data));}
    @Override public void onRequestPermissionsResult(int code,String[] permissions,int[] grants){
        super.onRequestPermissionsResult(code,permissions,grants);
        if(code==11&&cameraRequest!=null){if(foreground&&grants.length>0&&grants[0]==PackageManager.PERMISSION_GRANTED)cameraRequest.grant(new String[]{PermissionRequest.RESOURCE_VIDEO_CAPTURE});else cameraRequest.deny();cameraRequest=null;}
    }
    @Override protected void onActivityResult(int code,int result,Intent data){
        super.onActivityResult(code,result,data);
        if(code==PICK_VIDEO&&videoFileRequest!=null){
            ValueCallback<Uri[]> callback=videoFileRequest;videoFileRequest=null;
            Uri uri=result==RESULT_OK&&data!=null?data.getData():null;
            callback.onReceiveValue(uri!=null&&"content".equals(uri.getScheme())?new Uri[]{uri}:null);
        }
    }
    @Override protected void onResume(){super.onResume();foreground=true;if(web!=null)web.onResume();}
    @Override protected void onPause(){foreground=false;if(cameraRequest!=null){cameraRequest.deny();cameraRequest=null;}if(web!=null){web.evaluateJavascript("window.MotionApp&&window.MotionApp.suspend()",null);web.onPause();}super.onPause();}
    @Override public void onBackPressed(){web.evaluateJavascript("(()=>{const help=document.getElementById('help-dialog');if(help&&help.open){help.close();return true;}if(!document.getElementById('pullups').hidden){document.getElementById('pullup-back').click();return true;}if(document.getElementById('workout').hidden)return false;document.getElementById('back').click();return true;})()",result->{if("false".equals(result))MainActivity.super.onBackPressed();});}
    @Override protected void onDestroy(){if(videoFileRequest!=null){videoFileRequest.onReceiveValue(null);videoFileRequest=null;}if(web!=null){web.destroy();web=null;}super.onDestroy();}
}
