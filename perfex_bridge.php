<?php
/**
 * Bridge de Emergencia V5 - Modo Dios para GM Group
 */
header('Content-Type: application/json; charset=utf-8');
define('BASEPATH', 'index.php');
define('FCPATH', __DIR__ . '/');
define('APPPATH', __DIR__ . '/application/');

require_once(__DIR__ . '/application/config/app-config.php');

$secret_key = "EgyysBsXsJsKNj5HGWfF";
$received_token = $_GET['token'] ?? $_SERVER['HTTP_AUTHORIZATION'] ?? '';
$received_token = str_ireplace('Bearer ', '', $received_token);

if (trim($received_token) !== trim($secret_key)) {
    http_response_code(401);
    die(json_encode(['error' => 'Token inválido']));
}

$conn = mysqli_connect(APP_DB_HOSTNAME, APP_DB_USERNAME, APP_DB_PASSWORD, APP_DB_NAME);
if (!$conn) die(json_encode(['error' => 'Error de conexión DB']));
mysqli_set_charset($conn, "utf8");

$action = $_GET['action'] ?? $_POST['action'] ?? '';
$response = [];

switch ($action) {
    case 'get_customer_by_phone':
        $phone = preg_replace('/\D/', '', $_GET['phone'] ?? '');
        $last7 = substr($phone, -7);
        
        $sql = "SELECT c.userid as customerId, c.id as contactId, c.firstname, c.lastname, cl.company, c.email, cl.vat 
                FROM tblcontacts c 
                LEFT JOIN tblclients cl ON c.userid = cl.userid 
                WHERE c.phonenumber LIKE '%$last7%' OR cl.phonenumber LIKE '%$last7%' 
                LIMIT 1";
        
        $res = mysqli_query($conn, $sql);
        $result = mysqli_fetch_assoc($res);
        $response = $result ? array_merge($result, ['found' => true]) : ['found' => false, 'debug' => 'Buscando 7: '.$last7];
        break;

    case 'get_customer_by_email':
        $email = mysqli_real_escape_string($conn, trim($_GET['email'] ?? ''));
        $sql = "SELECT c.userid as customerId, c.id as contactId, c.firstname, c.lastname, cl.company, c.email, cl.vat 
                FROM tblcontacts c 
                LEFT JOIN tblclients cl ON c.userid = cl.userid 
                WHERE c.email = '$email' LIMIT 1";
        $res = mysqli_query($conn, $sql);
        $result = mysqli_fetch_assoc($res);
        $response = $result ? array_merge($result, ['found' => true]) : ['found' => false, 'debug' => 'Buscando email: '.$email];
        break;

    case 'get_customer_by_vat':
        $vat = preg_replace('/[^0-9]/', '', $_GET['vat'] ?? '');
        $sql = "SELECT cl.userid as customerId, c.id as contactId, c.firstname, c.lastname, cl.company, c.email, cl.vat 
                FROM tblclients cl 
                LEFT JOIN tblcontacts c ON cl.userid = c.userid 
                WHERE cl.vat LIKE '%$vat%' LIMIT 1";
        $res = mysqli_query($conn, $sql);
        $result = mysqli_fetch_assoc($res);
        $response = $result ? array_merge($result, ['found' => true]) : ['found' => false, 'debug' => 'Buscando NIT: '.$vat];
        break;

    case 'get_invoices':
        $cid = intval($_GET['customer_id']);
        $sql = "SELECT id, number, total, status, hash FROM tblinvoices WHERE clientid = $cid AND status != 2 ORDER BY date DESC LIMIT 5";
        $res = mysqli_query($conn, $sql);
        while ($row = mysqli_fetch_assoc($res)) {
            $row['view_url'] = "https://portal.gmgroup.com.co/invoice/" . $row['id'] . "/" . $row['hash'];
            $response[] = $row;
        }
        break;

    case 'get_projects':
        $cid = intval($_GET['customer_id']);
        $sql = "SELECT name as travel_plan FROM tblprojects WHERE clientid = $cid LIMIT 3";
        $res = mysqli_query($conn, $sql);
        while ($row = mysqli_fetch_assoc($res)) $response[] = $row;
        break;
}

echo json_encode($response, JSON_UNESCAPED_UNICODE);
mysqli_close($conn);